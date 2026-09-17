import type { StreamCheckResult, ErrorCategory, DiagnosticsConfig } from "../types";
import { getEventLoopLagMs, getMemoryPressure } from "./eventLoopMonitor";

// Bao gồm cả errno string của Node.js (ENOTFOUND, ETIMEDOUT...) LẪN văn phong lỗi kết nối gốc
// của chính ffmpeg/ffprobe (Operation timed out, Connection to tcp://... failed, TLS...) - hai lớp
// lỗi này thường bị bỏ sót nếu chỉ khớp theo errno Node.js, khiến lỗi mất kết nối tới origin (do
// WAF/rate-limit hoặc quá tải kết nối) bị phân loại nhầm thành STREAM ("Lỗi luồng HLS thực sự").
const NETWORK_ERROR_PATTERN =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|HTTP 5\d\d|Lỗi mạng|Connection refused|Name or service not known|Network is unreachable|Operation timed out|Connection to tcp|TLS|Server returned 5|Failed to resolve hostname|I\/O error/i;

export interface ClassifyDiagnostics {
  eventLoopLagMs: number;
  eventLoopLagThresholdMs: number;
  heapUsedRatio: number;
  memoryHeapUsedRatioThreshold: number;
  isSystemOverloaded: boolean;
}

/** Chụp nhanh tình trạng tài nguyên hệ thống tại thời điểm gọi - dùng làm bằng chứng phân loại SYSTEM_OVERLOAD. */
export function snapshotDiagnostics(config: DiagnosticsConfig): ClassifyDiagnostics {
  const eventLoopLagMs = getEventLoopLagMs();
  const { heapUsedRatio } = getMemoryPressure();

  return {
    eventLoopLagMs,
    eventLoopLagThresholdMs: config.eventLoopLagThresholdMs,
    heapUsedRatio,
    memoryHeapUsedRatioThreshold: config.memoryHeapUsedRatioThreshold,
    isSystemOverloaded:
      eventLoopLagMs > config.eventLoopLagThresholdMs || heapUsedRatio > config.memoryHeapUsedRatioThreshold,
  };
}

/**
 * Phân loại nguyên nhân gốc rễ của một lần kiểm tra thất bại (result.status !== "OK"):
 * - SYSTEM_OVERLOAD: event-loop lag/bộ nhớ cao tại thời điểm check, HOẶC ffprobe/ffmpeg timeout
 *   (được coi là dấu hiệu quá tải worker giám sát, không phải lỗi luồng thật) -> không gửi Telegram.
 * - NETWORK: lỗi tầng mạng khi lấy manifest hoặc khi ffmpeg đọc segment (DNS, connection reset, HTTP 5xx...).
 * - STREAM: manifest parse lỗi, HTTP 4xx (nội dung không còn tồn tại), mất track, tụt bitrate, đóng băng.
 */
export function classifyError(result: StreamCheckResult, diag: ClassifyDiagnostics): ErrorCategory {
  if (diag.isSystemOverloaded) return "SYSTEM_OVERLOAD";
  if (result.av?.timedOut) return "SYSTEM_OVERLOAD";

  if (!result.manifest.ok) {
    const err = result.manifest.error || "";
    return NETWORK_ERROR_PATTERN.test(err) ? "NETWORK" : "STREAM";
  }

  if (result.av?.error && NETWORK_ERROR_PATTERN.test(result.av.error)) {
    return "NETWORK";
  }

  return "STREAM";
}

export const ERROR_CATEGORY_LABEL: Record<ErrorCategory, string> = {
  SYSTEM_OVERLOAD: "Hệ thống giám sát quá tải",
  NETWORK: "Lỗi mạng / mất kết nối Origin-CDN",
  STREAM: "Lỗi luồng HLS thực sự",
};
