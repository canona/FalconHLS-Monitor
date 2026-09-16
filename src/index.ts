import dotenv from "dotenv";
dotenv.config();

import { loadConfig } from "./config/config";
import { logger } from "./logger/logger";
import { startScheduler } from "./monitor/scheduler";
import { startHealthServer } from "./monitor/healthServer";

async function main() {
  logger.info("=== StreamGuard HLS - Khởi động hệ thống giám sát ===");

  const config = loadConfig();
  logger.info(`Đã nạp cấu hình: ${config.streams.length} luồng cần giám sát`);

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    logger.warn(
      "TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID chưa được cấu hình - hệ thống vẫn chạy giám sát nhưng sẽ KHÔNG gửi được cảnh báo Telegram"
    );
  }

  const port = Number(process.env.PORT) || 3000;
  startHealthServer(port);

  const scheduler = startScheduler(config);

  const shutdown = (signal: string) => {
    logger.info(`Nhận tín hiệu ${signal}, đang dừng StreamGuard HLS...`);
    scheduler.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Chống crash toàn bộ tiến trình khi có lỗi bất ngờ (mạng chập chờn, FFmpeg treo, ...)
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled Promise Rejection", { reason: reason instanceof Error ? reason.message : reason });
  });
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception", { error: err.message, stack: err.stack });
  });
}

main().catch((err) => {
  logger.error("Lỗi nghiêm trọng khi khởi động StreamGuard HLS", { error: (err as Error).message });
  process.exit(1);
});
