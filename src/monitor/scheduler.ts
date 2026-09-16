import PQueue from "p-queue";
import type { AppConfig } from "../types";
import { checkStream } from "./streamChecker";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("scheduler");

/**
 * Bộ lập lịch: mỗi luồng có một interval riêng theo checkIntervalSeconds.
 * Tất cả các lần kiểm tra được đẩy vào một Worker Queue (p-queue) với concurrency
 * giới hạn (maxConcurrentChecks) để tránh nghẽn CPU/mạng khi có nhiều luồng cùng lúc,
 * đặc biệt vì Level 3 (ffprobe/ffmpeg) tốn tài nguyên.
 */
export function startScheduler(config: AppConfig): { stop: () => void } {
  const queue = new PQueue({ concurrency: config.maxConcurrentChecks });
  const timers: NodeJS.Timeout[] = [];

  const enqueueCheck = (stream: (typeof config.streams)[number]) => {
    queue
      .add(async () => {
        try {
          const result = await checkStream(stream, config);
          log.info(`Kiểm tra hoàn tất: ${stream.name}`, { status: result.status, issueCount: result.issues.length });
        } catch (err) {
          log.error(`Lỗi không mong muốn khi kiểm tra luồng ${stream.name}`, { error: (err as Error).message });
        }
      })
      .catch((err) => {
        log.error(`Lỗi hàng đợi khi xử lý luồng ${stream.name}`, { error: (err as Error).message });
      });
  };

  for (const stream of config.streams) {
    // Chạy ngay lần đầu khi khởi động
    enqueueCheck(stream);

    const timer = setInterval(() => enqueueCheck(stream), config.checkIntervalSeconds * 1000);
    timers.push(timer);
  }

  log.info(`Scheduler khởi động: ${config.streams.length} luồng, interval ${config.checkIntervalSeconds}s, concurrency ${config.maxConcurrentChecks}`);

  return {
    stop: () => {
      timers.forEach(clearInterval);
      queue.clear();
    },
  };
}
