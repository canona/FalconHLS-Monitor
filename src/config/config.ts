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

const ConfigSchema = z.object({
  streams: z.array(StreamSchema).min(1, "Cần khai báo ít nhất 1 luồng trong config"),
  checkIntervalSeconds: z.number().positive(),
  cooldownMinutes: z.number().positive(),
  timeoutSeconds: z.number().positive(),
  ffprobeDurationSeconds: z.number().positive(),
  maxConcurrentChecks: z.number().int().positive(),
  thresholds: ThresholdsSchema,
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
