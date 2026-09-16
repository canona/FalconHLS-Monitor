import type { AlertBatchingConfig, AlertIncident } from "../types";
import { sendTelegramMessage, buildIncidentMessage, buildDigestMessage } from "./telegramBot";
import { logDiagnostic } from "../logger/diagnosticLogger";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("alert-manager");

let config: AlertBatchingConfig = { windowMs: 12_000, minCountToDigest: 3 };
let buffer: AlertIncident[] = [];
let flushTimer: NodeJS.Timeout | null = null;

/**
 * AlertManager: chống spam Telegram khi nhiều luồng cùng gặp sự cố (VD sự cố mạng tổng/CDN).
 * Thay vì gửi ngay mỗi khi 1 luồng được XÁC NHẬN degraded/down (đã qua retry), sự cố được gom
 * vào 1 buffer trong `windowMs`. Khi buffer đầy hạn: nếu số lượng > `minCountToDigest` thì gộp
 * thành 1 tin nhắn digest duy nhất; ngược lại gửi riêng từng tin như bình thường.
 */
export function configureAlertManager(cfg: AlertBatchingConfig): void {
  config = cfg;
}

export function enqueueAlert(incident: AlertIncident): void {
  buffer.push(incident);
  logDiagnostic("alert_enqueued", { stream: incident.streamName, category: incident.category, bufferSize: buffer.length });

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, config.windowMs);
    flushTimer.unref();
  }
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;

  const incidents = buffer;
  buffer = [];

  if (incidents.length > config.minCountToDigest) {
    logDiagnostic("alert_digest_sent", { count: incidents.length, streams: incidents.map((i) => i.streamName) });
    log.warn(`Gộp ${incidents.length} cảnh báo trong cùng khung ${config.windowMs}ms thành 1 tin nhắn digest`, {
      streams: incidents.map((i) => i.streamName),
    });
    await sendTelegramMessage(buildDigestMessage(incidents));
    return;
  }

  for (const incident of incidents) {
    logDiagnostic("alert_sent", { stream: incident.streamName, category: incident.category, status: incident.status });
    await sendTelegramMessage(buildIncidentMessage(incident));
  }
}

/** Gửi ngay các cảnh báo đang chờ trong buffer, không đợi hết windowMs - dùng khi shutdown. */
export async function flushAlertsNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}
