export type StreamType = "tv" | "radio";

export interface StreamConfig {
  name: string;
  url: string;
  /** "tv" (mặc định, yêu cầu cả Video+Audio) hoặc "radio" (chỉ yêu cầu Audio, bỏ qua kiểm tra Video). */
  type: StreamType;
}

export interface Thresholds {
  minVideoBitrateKbps: number;
  minAudioBitrateKbps: number;
  maxPacketLossPercentage: number;
  maxManifestLatencyMs: number;
}

export interface RetryConfig {
  /** Tổng số lần kiểm tra liên tiếp thất bại (kể cả lần đầu) trước khi xác nhận DEGRADED/DOWN. */
  maxRetries: number;
  /** Độ trễ (ms) trước mỗi lần retry, độ dài = maxRetries - 1. VD [5000, 10000]. */
  retryDelaysMs: number[];
}

export interface AlertBatchingConfig {
  /** Khung thời gian (ms) gom các cảnh báo lại trước khi gửi. */
  windowMs: number;
  /** Nếu số lỗi trong 1 khung > giá trị này, gộp thành 1 tin nhắn digest thay vì gửi riêng lẻ. */
  minCountToDigest: number;
}

export interface DiagnosticsConfig {
  /** Event-loop lag (ms) vượt ngưỡng này -> nghi ngờ quá tải hệ thống giám sát. */
  eventLoopLagThresholdMs: number;
  /** Tỉ lệ heapUsed/heapTotal vượt ngưỡng này -> nghi ngờ áp lực bộ nhớ. */
  memoryHeapUsedRatioThreshold: number;
  /** ffprobe/ffmpeg chạy lâu hơn ngưỡng này (dù vẫn thành công) -> log cảnh báo nghẽn (bottleneck), không tính lỗi. */
  ffprobeSlowThresholdMs: number;
}

export interface AppConfig {
  streams: StreamConfig[];
  checkIntervalSeconds: number;
  cooldownMinutes: number;
  timeoutSeconds: number;
  ffprobeDurationSeconds: number;
  /** Số tiến trình ffprobe/ffmpeg (Level 3) chạy đồng thời tối đa trên toàn hệ thống. */
  maxConcurrentChecks: number;
  /** Số luồng được kiểm tra Level 1/2 (HTTP, nhẹ) đồng thời tối đa. */
  maxConcurrentManifestChecks: number;
  thresholds: Thresholds;
  retry: RetryConfig;
  alertBatching: AlertBatchingConfig;
  diagnostics: DiagnosticsConfig;
}

export type HealthStatus = "OK" | "DEGRADED" | "DOWN";

/** Nguyên nhân gốc rễ của một lần kiểm tra thất bại. */
export type ErrorCategory = "SYSTEM_OVERLOAD" | "NETWORK" | "STREAM";

export interface ManifestSegment {
  uri: string;
  duration: number;
}

export interface ManifestVariant {
  uri: string;
  bandwidth: number;
  audioGroupId: string | null;
}

export interface AudioRendition {
  groupId: string;
  uri: string;
}

export interface ParsedManifest {
  isMaster: boolean;
  targetDuration: number | null;
  mediaSequence: number | null;
  endList: boolean;
  segments: ManifestSegment[];
  variants: ManifestVariant[];
  audioRenditions: AudioRendition[];
}

export interface ManifestCheckResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  error?: string;
  manifest?: ParsedManifest;
  resolvedUrl: string;
  /** URL của audio rendition riêng biệt (EXT-X-MEDIA), nếu master playlist tách audio khỏi video variant. */
  resolvedAudioUrl?: string;
}

export interface FreezeCheckResult {
  frozen: boolean;
  isVod: boolean;
  mediaSequence: number | null;
  lastSegmentUri: string | null;
  segmentCount: number;
}

export interface AvAnalysisResult {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number | null;
  packetLossPercentage: number;
  error?: string;
  /** true nếu lỗi trên là do ffprobe/ffmpeg timeout (không có phản hồi trong timeoutSeconds). */
  timedOut?: boolean;
  /** Tổng thời gian thực thi Level 3 (ms), bao gồm cả thời gian chờ trong queue ffprobe. */
  executionMs?: number;
}

/** Dữ liệu tối giản của 1 sự cố đã được XÁC NHẬN (qua retry) - dùng để build message Telegram (đơn lẻ hoặc digest). */
export interface AlertIncident {
  streamName: string;
  status: HealthStatus;
  category: ErrorCategory;
  issues: string[];
  checkedAt: Date;
  /** Số lần kiểm tra liên tiếp đã xác nhận sự cố (bao gồm lần đầu + các lần retry). */
  attempts: number;
}

export interface StreamCheckResult {
  streamName: string;
  checkedAt: Date;
  status: HealthStatus;
  issues: string[];
  manifest: ManifestCheckResult;
  freeze?: FreezeCheckResult;
  av?: AvAnalysisResult;
}

export type StreamPhase = "STABLE" | "SUSPECT";

export interface StreamRuntimeState {
  /** Trạng thái đã XÁC NHẬN cuối cùng (sau khi qua retry) - dùng cho health endpoint & quyết định alert. */
  lastStatus: HealthStatus;
  /** STABLE = bình thường; SUSPECT = đang trong chu trình xác minh lại (chưa xác nhận lỗi thật). */
  phase: StreamPhase;
  /** Số lần kiểm tra liên tiếp thất bại kể từ khi vào SUSPECT (không tính các lần bị phân loại SYSTEM_OVERLOAD). */
  suspectAttempt: number;
  suspectSince: Date | null;
  /** true khi đang có 1 lần kiểm tra thực sự chạy (trong queue hoặc đang thực thi) - chống chồng lấn. */
  isChecking: boolean;
  /** Timer của lần retry đang chờ, để có thể clear khi cần (VD lúc shutdown). */
  pendingRetryTimer: NodeJS.Timeout | null;
  lastAlertAt: Date | null;
  lastMediaSequence: number | null;
  lastSegmentUri: string | null;
  lastManifestChangeAt: Date | null;
  lastCheckedAt: Date | null;
  consecutiveFailures: number;
}
