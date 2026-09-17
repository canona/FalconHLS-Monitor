import fs from "fs";
import path from "path";
import { z } from "zod";
import type { AppConfig } from "../types";

const StreamSchema = z.object({
  name: z.string().min(1, "Tên luồng không được rỗng"),
  url: z.string().url("URL luồng không hợp lệ"),
  type: z.enum(["tv", "radio"]).default("tv"),
});

const ThresholdsSchema = z.object({
  minVideoBitrateKbps: z.number().positive(),
  minAudioBitrateKbps: z.number().positive(),
  maxPacketLossPercentage: z.number().min(0),
  maxManifestLatencyMs: z.number().positive(),
});

const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(1).default(3),
  retryDelaysMs: z.array(z.number().positive()).min(1).default([5000, 10000]),
});

const RetrySchema = RetryPolicySchema.extend({
  // Chính sách retry riêng cho category NETWORK (timeout/refused khi kết nối origin, thường do
  // WAF/anti-leech rate-limit khi giám sát nhiều kênh chung 1 origin) - kiên nhẫn hơn hẳn STREAM
  // (lỗi nội dung thật: mất track, tụt bitrate...) để origin có đủ thời gian "hạ nhiệt" trước khi
  // hệ thống kết luận luồng đã chết và gửi Telegram. Mặc định 5 lần, delay [15s, 30s, 30s, 30s].
  network: RetryPolicySchema.extend({
    maxRetries: z.number().int().min(1).default(5),
    retryDelaysMs: z.array(z.number().positive()).min(1).default([15000, 30000, 30000, 30000]),
  }).default({}),
}).default({});

const AlertBatchingSchema = z
  .object({
    // 10s (không phải 60s như bản đầu) - nếu tại thời điểm hết hạn window chỉ có 1 sự cố duy nhất
    // trong buffer, flush() vẫn gửi ngay dưới dạng tin đơn lẻ (xem alertManager.ts::flush), nên
    // windowMs ngắn giúp giảm độ trễ cảm nhận được cho trường hợp phổ biến (1 kênh lỗi đơn lẻ) mà
    // vẫn đủ thời gian bắt sự cố diện rộng (nhiều kênh chung origin thường xác nhận lệch nhau vài
    // giây do scheduler dàn đều lịch check, không phải cùng 1 khoảnh khắc).
    windowMs: z.number().positive().default(10000),
    minCountToDigest: z.number().int().positive().default(3),
  })
  .default({});

const DiagnosticsSchema = z
  .object({
    eventLoopLagThresholdMs: z.number().positive().default(200),
    memoryHeapUsedRatioThreshold: z.number().min(0).max(1).default(0.9),
    ffprobeSlowThresholdMs: z.number().positive().default(8000),
  })
  .default({});

const ConfigSchema = z.object({
  streams: z.array(StreamSchema).min(1, "Cần khai báo ít nhất 1 luồng trong config"),
  checkIntervalSeconds: z.number().positive(),
  cooldownMinutes: z.number().positive(),
  timeoutSeconds: z.number().positive(),
  ffprobeDurationSeconds: z.number().positive(),
  maxConcurrentChecks: z.number().int().positive(),
  maxConcurrentManifestChecks: z.number().int().positive().default(10),
  // Giới hạn số kết nối Level 3 đồng thời tới CÙNG một hostname, độc lập với maxConcurrentChecks
  // (giới hạn tổng). Xem eventLoopMonitor/ffprobe.ts::configureHostConcurrency.
  maxConcurrentPerHost: z.number().int().positive().default(2),
  thresholds: ThresholdsSchema,
  retry: RetrySchema,
  alertBatching: AlertBatchingSchema,
  diagnostics: DiagnosticsSchema,
});

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH || "./config.json");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Không tìm thấy file cấu hình tại: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`File cấu hình ${configPath} không phải JSON hợp lệ: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`File cấu hình không hợp lệ:\n${details}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function reloadConfig(): AppConfig {
  cachedConfig = null;
  return loadConfig();
}
