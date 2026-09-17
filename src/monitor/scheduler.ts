import PQueue from "p-queue";
import type { AppConfig, StreamConfig } from "../types";
import { checkStream } from "./streamChecker";
import { checkManifest } from "./manifestChecker";
import { checkFreeze } from "./freezeChecker";
import { processCheckResult } from "./incidentManager";
import { getState, setState, clearAllPendingRetries } from "./stateStore";
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
 */
export function startScheduler(config: AppConfig): { stop: () => void } {
  const manifestQueue = new PQueue({ concurrency: config.maxConcurrentManifestChecks });
  const timers: NodeJS.Timeout[] = [];

  const runCheck = (stream: StreamConfig) => {
    const state = getState(stream.name);
    if (state.isChecking) {
      logDiagnostic("skip_overlap", { stream: stream.name });
      return;
    }
    setState(stream.name, { ...state, isChecking: true });

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
        setState(stream.name, { ...getState(stream.name), isChecking: false });
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
    const state = getState(stream.name);
    if (state.isChecking || state.phase === "SUSPECT" || state.lastStatus !== "OK") {
      fastFreezeStreak.delete(stream.name);
      return;
    }

    const manifest = await manifestQueue.add(() => checkManifest(stream.url, config.timeoutSeconds));
    if (!manifest || getState(stream.name).isChecking) return;

    if (!manifest.ok || !manifest.manifest) {
      fastFreezeStreak.delete(stream.name);
      logDiagnostic("fast_probe_manifest_fail", { stream: stream.name, error: manifest.error });
      runCheck(stream);
      return;
    }

    const freeze = checkFreeze(manifest.manifest, getState(stream.name));
    if (!freeze.frozen) {
      fastFreezeStreak.delete(stream.name);
      return;
    }

    const streak = (fastFreezeStreak.get(stream.name) ?? 0) + 1;
    logDiagnostic("fast_probe_freeze_detected", { stream: stream.name, mediaSequence: freeze.mediaSequence, streak });

    if (streak >= FAST_FREEZE_CONFIRM_READS) {
      fastFreezeStreak.delete(stream.name);
      runCheck(stream);
    } else {
      fastFreezeStreak.set(stream.name, streak);
    }
  };

  // Dàn đều thời điểm bắt đầu của từng luồng trên CẢ chu kỳ checkIntervalSeconds, thay vì để TẤT
  // CẢ luồng bắn check đầu tiên (và mọi chu kỳ interval sau đó, vì cùng chung pha) trong cùng 1
  // khoảnh khắc. Nếu không dàn đều, N luồng cùng chung 1 origin sẽ tạo ra 1 đợt dồn kết nối TCP
  // lặp lại đúng mỗi checkIntervalSeconds (thundering herd định kỳ) ngay cả khi đã có hàng đợi giới
  // hạn concurrency theo host/tổng - hàng đợi chỉ giới hạn số CHẠY ĐỒNG THỜI, không giới hạn việc
  // TẤT CẢ cùng ập vào hàng đợi đó trong cùng 1 thời điểm mỗi chu kỳ. Đã tái hiện thực tế: 25 kênh
  // chung 1 origin vẫn bị timeout kết nối hàng loạt ngay sau mỗi lần deploy/restart dù đã throttle.
  config.streams.forEach((stream, index) => {
    const staggerMs = Math.floor((index * config.checkIntervalSeconds * 1000) / config.streams.length);

    const startTimer = setTimeout(() => {
      runCheck(stream);

      const timer = setInterval(() => {
        if (getState(stream.name).phase === "SUSPECT") {
          logDiagnostic("skip_suspect_interval", { stream: stream.name });
          return;
        }
        runCheck(stream);
      }, config.checkIntervalSeconds * 1000);
      timers.push(timer);
    }, staggerMs);
    timers.push(startTimer);
  });

  // Lịch riêng cho watchdog Level 1+2 - dàn đều tương tự lịch chậm ở trên, cùng lý do (tránh dồn
  // cục request mỗi fastCheckIntervalSeconds).
  config.streams.forEach((stream, index) => {
    const fastStaggerMs = Math.floor((index * config.fastCheckIntervalSeconds * 1000) / config.streams.length);

    const fastStartTimer = setTimeout(() => {
      void runFastProbe(stream);

      const fastTimer = setInterval(() => {
        void runFastProbe(stream);
      }, config.fastCheckIntervalSeconds * 1000);
      timers.push(fastTimer);
    }, fastStaggerMs);
    timers.push(fastStartTimer);
  });

  log.info(
    `Scheduler khởi động: ${config.streams.length} luồng, interval Level1-3 ${config.checkIntervalSeconds}s, ` +
      `interval watchdog Level1+2 ${config.fastCheckIntervalSeconds}s, ` +
      `manifest-concurrency ${config.maxConcurrentManifestChecks}, ffprobe-concurrency ${config.maxConcurrentChecks}`
  );

  return {
    stop: () => {
      timers.forEach(clearInterval);
      clearAllPendingRetries();
      manifestQueue.clear();
    },
  };
}
