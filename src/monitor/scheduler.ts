import PQueue from "p-queue";
import type { AppConfig, StreamConfig } from "../types";
import { checkStream } from "./streamChecker";
import { checkManifest } from "./manifestChecker";
import { checkFreeze } from "./freezeChecker";
import { processCheckResult } from "./incidentManager";
import { getState, setState, removeState, clearAllPendingRetries } from "./stateStore";
import { logDiagnostic } from "../logger/diagnosticLogger";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("scheduler");

/**
 * Bộ lập lịch: mỗi luồng có một interval riêng theo checkIntervalSeconds.
 * Level 1/2 (HTTP, nhẹ) được xếp qua `manifestQueue` với concurrency = maxConcurrentManifestChecks.
 * Level 3 (ffprobe/ffmpeg, nặng CPU/network) có queue RIÊNG bên trong `ffprobe.ts`, giới hạn theo
 * maxConcurrentChecks - tách biệt để 30 luồng HTTP check không bị chặn bởi ffprobe đang bận.
 *
 * Hai cơ chế chống quá tải bổ sung:
 *  - `isChecking`: không cho phép 2 lần kiểm tra CÙNG một luồng chạy chồng lấn.
 *  - Bỏ qua lịch interval bình thường khi luồng đang ở phase SUSPECT (đang tự retry riêng qua
 *    `incidentManager`) - tránh vừa retry vừa bị interval cũ bắn thêm 1 lần kiểm tra song song.
 *
 * Ngoài lịch chậm (Level 1->2->3 đầy đủ) ở trên, còn có `runFastProbe` chạy theo
 * `fastCheckIntervalSeconds` - CHỈ Level 1+2, dùng làm "watchdog" phát hiện sớm manifest lỗi/đóng
 * băng mà không phải đợi tới lượt Level 3 (có thể tới vài phút khi giám sát nhiều kênh chung 1
 * origin bị giới hạn `maxConcurrentPerHost`). Xem chi tiết ở `runFastProbe` bên dưới.
 *
 * Danh sách luồng KHÔNG còn cố định lúc khởi động - luồng đến từ staticStreams (config.json) +
 * Partner API, có thể thêm/bớt bất kỳ lúc nào qua `addStreams`/`removeStream` (xem streamSyncService.ts).
 * Mọi khóa nội bộ (state, watchdog streak) dùng `stream.id` (= `partner:name`), KHÔNG dùng `stream.name`,
 * vì 2 Partner khác nhau có thể đặt tên kênh trùng nhau.
 */
export function startScheduler(config: AppConfig): {
  addStreams: (streams: StreamConfig[]) => void;
  removeStream: (id: string) => void;
  stop: () => void;
} {
  const manifestQueue = new PQueue({ concurrency: config.maxConcurrentManifestChecks });
  const timersByStream = new Map<string, NodeJS.Timeout[]>();

  const runCheck = (stream: StreamConfig) => {
    const state = getState(stream.id);
    if (state.isChecking) {
      logDiagnostic("skip_overlap", { stream: stream.name, streamId: stream.id });
      return;
    }
    setState(stream.id, { ...state, isChecking: true });

    manifestQueue
      .add(() => checkStream(stream, config))
      .then((result) => {
        if (!result) return;
        processCheckResult(stream, config, result, runCheck);
      })
      .catch((err) => {
        log.error(`Lỗi không mong muốn khi kiểm tra luồng ${stream.name}`, { error: (err as Error).message });
      })
      .finally(() => {
        setState(stream.id, { ...getState(stream.id), isChecking: false });
      });
  };

  /**
   * "Watchdog" nhẹ: chỉ Level 1 (HTTP GET manifest) + Level 2 (so sánh media-sequence/segment cuối
   * với state hiện có) - KHÔNG bao giờ đụng tới `analyzeStream`/hostQueue/ffprobeQueue, nên có thể
   * chạy dày (mặc định 15s) mà không gây thêm áp lực kết nối lên origin.
   *
   * CHỈ ĐƯỢC PHÉP LEO THANG (kích hoạt sớm 1 lần `runCheck` đầy đủ), KHÔNG BAO GIỜ tự ghi state hay
   * hạ cấp/xác nhận sự cố - việc đó vẫn thuộc về `incidentManager` qua `runCheck` như cũ. Thiết kế
   * một chiều này để tránh 1 lỗi nghiêm trọng: nếu probe nhẹ này tự gọi `processCheckResult` với
   * status "OK" mỗi 15s, nó sẽ xóa mất tiến trình SUSPECT/retry đang tích lũy từ 1 lần kiểm tra Level
   * 3 chậm hơn (vì Level 1+2 "OK" không có nghĩa là luồng thực sự ổn - Level 3 có thể đang phát hiện
   * tụt bitrate/mất track mà probe nhẹ này hoàn toàn không biết).
   *
   * Chỉ kích hoạt khi luồng đang ở trạng thái tưởng như ổn định (`STABLE` + `lastStatus === "OK"` +
   * không đang check dở) - nếu đã SUSPECT (đang tự retry) hoặc đã xác nhận lỗi (đang trong cooldown,
   * chờ chu kỳ chậm kiểm tra lại để phát hiện phục hồi), bỏ qua để không kích hoạt trùng lặp/vô ích.
   *
   * Yêu cầu phát hiện "đóng băng" ở 2 LẦN ĐỌC LIÊN TIẾP (cách nhau fastCheckIntervalSeconds) mới
   * kích hoạt `runCheck` - đã tái hiện thực tế: nhiều origin/CDN cache response manifest vài giây,
   * nên 2 lần GET cách nhau ngắn (15s) có thể tình cờ trả về CÙNG media-sequence dù luồng vẫn đang
   * phát bình thường (khoảng cách 180s của lịch chậm trước đây hiếm khi rơi vào tình huống này nên
   * chưa từng lộ ra). 1 lần đọc trùng do cache là chuyện thường; 2 lần liên tiếp mới đáng ngờ.
   */
  const fastFreezeStreak = new Map<string, number>();
  const FAST_FREEZE_CONFIRM_READS = 2;

  const runFastProbe = async (stream: StreamConfig) => {
    const state = getState(stream.id);
    if (state.isChecking || state.phase === "SUSPECT" || state.lastStatus !== "OK") {
      fastFreezeStreak.delete(stream.id);
      return;
    }

    const manifest = await manifestQueue.add(() => checkManifest(stream.url, config.timeoutSeconds));
    if (!manifest || getState(stream.id).isChecking) return;

    if (!manifest.ok || !manifest.manifest) {
      fastFreezeStreak.delete(stream.id);
      logDiagnostic("fast_probe_manifest_fail", { stream: stream.name, streamId: stream.id, error: manifest.error });
      runCheck(stream);
      return;
    }

    const freeze = checkFreeze(manifest.manifest, getState(stream.id));
    if (!freeze.frozen) {
      fastFreezeStreak.delete(stream.id);
      return;
    }

    const streak = (fastFreezeStreak.get(stream.id) ?? 0) + 1;
    logDiagnostic("fast_probe_freeze_detected", {
      stream: stream.name,
      streamId: stream.id,
      mediaSequence: freeze.mediaSequence,
      streak,
    });

    if (streak >= FAST_FREEZE_CONFIRM_READS) {
      fastFreezeStreak.delete(stream.id);
      runCheck(stream);
    } else {
      fastFreezeStreak.set(stream.id, streak);
    }
  };

  // Dàn đều thời điểm bắt đầu của từng luồng trong CHÍNH BATCH được thêm vào (không còn biết trước
  // tổng số luồng cố định lúc khởi động, vì danh sách có thể lớn dần qua các lần sync Partner API).
  // N luồng cùng chung 1 origin thêm vào CÙNG 1 lần gọi addStreams (VD lần sync đầu tiên có nhiều
  // kênh mới) vẫn được dàn đều để tránh thundering herd; các lần thêm lẻ tẻ sau đó (1-2 kênh mới mỗi
  // 5 phút) rủi ro dồn cục thấp hơn nhiều so với lúc khởi động hàng loạt.
  function scheduleOne(stream: StreamConfig, staggerMs: number, fastStaggerMs: number): void {
    const timers: NodeJS.Timeout[] = [];

    const startTimer = setTimeout(() => {
      runCheck(stream);

      const timer = setInterval(() => {
        if (getState(stream.id).phase === "SUSPECT") {
          logDiagnostic("skip_suspect_interval", { stream: stream.name, streamId: stream.id });
          return;
        }
        runCheck(stream);
      }, config.checkIntervalSeconds * 1000);
      timers.push(timer);
    }, staggerMs);
    timers.push(startTimer);

    const fastStartTimer = setTimeout(() => {
      void runFastProbe(stream);

      const fastTimer = setInterval(() => {
        void runFastProbe(stream);
      }, config.fastCheckIntervalSeconds * 1000);
      timers.push(fastTimer);
    }, fastStaggerMs);
    timers.push(fastStartTimer);

    timersByStream.set(stream.id, timers);
  }

  function addStreams(streams: StreamConfig[]): void {
    const toAdd = streams.filter((s) => !timersByStream.has(s.id));
    if (toAdd.length === 0) return;

    toAdd.forEach((stream, index) => {
      const staggerMs = Math.floor((index * config.checkIntervalSeconds * 1000) / toAdd.length);
      const fastStaggerMs = Math.floor((index * config.fastCheckIntervalSeconds * 1000) / toAdd.length);
      scheduleOne(stream, staggerMs, fastStaggerMs);
    });

    log.info(`Scheduler: thêm ${toAdd.length} luồng mới (tổng hiện tại: ${timersByStream.size})`);
  }

  function removeStream(id: string): void {
    const timers = timersByStream.get(id);
    if (!timers) return;

    timers.forEach(clearInterval);
    timersByStream.delete(id);
    fastFreezeStreak.delete(id);
    removeState(id);

    log.info(`Scheduler: đã gỡ luồng ${id} (tổng hiện tại: ${timersByStream.size})`);
  }

  return {
    addStreams,
    removeStream,
    stop: () => {
      timersByStream.forEach((timers) => timers.forEach(clearInterval));
      timersByStream.clear();
      clearAllPendingRetries();
      manifestQueue.clear();
    },
  };
}
