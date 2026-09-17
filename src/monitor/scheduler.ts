import PQueue from "p-queue";
import type { AppConfig, StreamConfig } from "../types";
import { checkStream } from "./streamChecker";
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

  log.info(
    `Scheduler khởi động: ${config.streams.length} luồng, interval ${config.checkIntervalSeconds}s, ` +
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
