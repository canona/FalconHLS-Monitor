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

  for (const stream of config.streams) {
    runCheck(stream);

    const timer = setInterval(() => {
      if (getState(stream.name).phase === "SUSPECT") {
        logDiagnostic("skip_suspect_interval", { stream: stream.name });
        return;
      }
      runCheck(stream);
    }, config.checkIntervalSeconds * 1000);
    timers.push(timer);
  }

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
