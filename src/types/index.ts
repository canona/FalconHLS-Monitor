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

export interface AppConfig {
  streams: StreamConfig[];
  checkIntervalSeconds: number;
  cooldownMinutes: number;
  timeoutSeconds: number;
  ffprobeDurationSeconds: number;
  maxConcurrentChecks: number;
  thresholds: Thresholds;
}

export type HealthStatus = "OK" | "DEGRADED" | "DOWN";

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

export interface StreamRuntimeState {
  lastStatus: HealthStatus;
  lastAlertAt: Date | null;
  lastMediaSequence: number | null;
  lastSegmentUri: string | null;
  lastManifestChangeAt: Date | null;
  lastCheckedAt: Date | null;
  consecutiveFailures: number;
}
