import winston from "winston";
import { formatVnTime } from "../utils/time";

const vnTimestamp = winston.format((info) => {
  info.timestamp = formatVnTime(new Date());
  return info;
})();

/**
 * Log riêng cho mục đích chẩn đoán sâu (retry, thời gian thực thi ffprobe, phân loại lỗi,
 * lý do skip check...) - tách khỏi log vận hành chính để không làm loãng console/log chính,
 * nhưng vẫn đủ chi tiết để trace lại nguyên nhân đằng sau một cảnh báo cụ thể.
 */
export const diagnosticLogger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(vnTimestamp, winston.format.json()),
  transports: [
    new winston.transports.File({
      filename: process.env.DIAGNOSTIC_LOG_PATH || "diagnostic.log",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exitOnError: false,
});

export function logDiagnostic(event: string, meta: Record<string, unknown> = {}): void {
  diagnosticLogger.info(event, meta);
}
