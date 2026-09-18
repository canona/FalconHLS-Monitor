import dotenv from "dotenv";
dotenv.config();

import { loadConfig } from "./config/config";
import { logger } from "./logger/logger";
import { startScheduler } from "./monitor/scheduler";
import { setStaticStreams, getStreams } from "./monitor/streamRegistry";
import { startPartnerSync } from "./partners/streamSyncService";
import { startWebServer } from "./web/server";
import { startEventLoopMonitor } from "./monitor/eventLoopMonitor";
import { configureFfprobeConcurrency, configureHostConcurrency } from "./ffmpeg/ffprobe";
import { configureAlertManager, flushAlertsNow } from "./telegram/alertManager";

async function main() {
  logger.info("=== StreamGuard HLS - Khởi động hệ thống giám sát ===");

  const config = loadConfig();

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    logger.warn(
      "TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID chưa được cấu hình - hệ thống vẫn chạy giám sát nhưng sẽ KHÔNG gửi được cảnh báo Telegram"
    );
  }

  startEventLoopMonitor();
  configureFfprobeConcurrency(config.maxConcurrentChecks);
  configureHostConcurrency(config.maxConcurrentPerHost);
  configureAlertManager(config.alertBatching);

  const port = Number(process.env.PORT) || 3000;
  startWebServer(port);

  const scheduler = startScheduler(config);

  // Luồng khai báo tay (staticStreams) chạy ngay, không cần đợi lần sync Partner API đầu tiên.
  setStaticStreams(config.staticStreams);
  scheduler.addStreams(getStreams());

  // Lần sync Partner API đầu tiên được await bên trong startPartnerSync trước khi trả về, nên tổng số
  // luồng dưới đây đã bao gồm cả static + partner ngay khi khởi động xong.
  const partnerSync = await startPartnerSync((added, removed) => {
    // GỠ trước rồi mới THÊM: 1 kênh đổi URL (VD VTVgo xoay token pull) xuất hiện ở CẢ 2 mảng cùng lúc
    // (cùng id) - addStreams() bỏ qua id đã tồn tại, nên phải removeStream() giải phóng id đó trước,
    // nếu không kênh sẽ bị coi là "đã lịch" và giữ mãi URL cũ đã hết hiệu lực.
    removed.forEach((s) => scheduler.removeStream(s.id));
    scheduler.addStreams(added);
  });

  logger.info(`Đã nạp cấu hình: ${getStreams().length} luồng cần giám sát`);

  const shutdown = (signal: string) => {
    logger.info(`Nhận tín hiệu ${signal}, đang dừng StreamGuard HLS...`);
    scheduler.stop();
    partnerSync.stop();
    Promise.race([flushAlertsNow(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => {
      process.exit(0);
    });
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
