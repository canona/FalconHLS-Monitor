import { spawn } from "child_process";
import PQueue from "p-queue";
import { createChildLogger } from "../logger/logger";
import { logDiagnostic } from "../logger/diagnosticLogger";
import type { AvAnalysisResult } from "../types";

const log = createChildLogger("ffprobe");

/**
 * Queue riêng giới hạn số tiến trình ffprobe/ffmpeg (Level 3) chạy đồng thời trên TOÀN hệ thống,
 * độc lập với queue Level 1/2 (nhẹ hơn nhiều). Đây là nút thắt tài nguyên thật (CPU decode + network
 * fetch segment) khi giám sát nhiều luồng cùng lúc - ép nghiêm ngặt theo `maxConcurrentChecks`.
 */
let ffprobeQueue = new PQueue({ concurrency: 5 });

export function configureFfprobeConcurrency(limit: number): void {
  ffprobeQueue = new PQueue({ concurrency: limit });
}

export function getFfprobeQueueStats(): { size: number; pending: number } {
  return { size: ffprobeQueue.size, pending: ffprobeQueue.pending };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
}

/** Chạy một tiến trình con (ffprobe/ffmpeg) với timeout cứng, không để treo worker. */
function runProcess(command: string, args: string[], timeoutSeconds: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += `\n[spawn-error] ${err.message}`;
      resolve({ stdout, stderr, timedOut, exitCode: null });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, exitCode: code });
    });
  });
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { bit_rate?: string };
}

async function probeMetadata(
  url: string,
  timeoutSeconds: number
): Promise<{ hasVideo: boolean; hasAudio: boolean; videoCodec: string | null; audioCodec: string | null }> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-analyzeduration",
    "5000000",
    "-probesize",
    "5000000",
    url,
  ];

  const result = await runProcess("ffprobe", args, timeoutSeconds);

  if (result.timedOut) {
    throw new Error(`ffprobe timeout sau ${timeoutSeconds}s khi đọc metadata`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`ffprobe lỗi (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Không parse được JSON output của ffprobe");
  }

  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === "video") || null;
  const audioStream = streams.find((s) => s.codec_type === "audio") || null;

  return {
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
  };
}

interface TrackMeasurement {
  bitrateKbps: number | null;
  /** Số frame video (khi có "frame=" trong stats) hoặc số tick tiến trình (fallback cho audio-only). */
  sampleCount: number;
  errorCount: number;
  streamMissing: boolean;
}

const DECODE_ERROR_PATTERN =
  /(continuity count error|continuity check failed|corrupt|missing picture in access unit|concealing \d+ dc|error while decoding|invalid data found when processing input|non-monotonic dts)/i;

const EMPTY_MEASUREMENT: TrackMeasurement = { bitrateKbps: null, sampleCount: 0, errorCount: 0, streamMissing: true };

/**
 * Đo 1 track (video hoặc audio) bằng MỘT lệnh ffmpeg duy nhất với 2 output song song:
 *  - Output 1 (`-c copy -f mpegts pipe:1`): remux nguyên bitstream ra stdout, KHÔNG decode.
 *    Bitrate thực tế được tính từ số byte thực nhận được / thời gian thực chạy - đây là số đo
 *    đáng tin cậy (muxer "null" ở phương án cũ luôn trả "bitrate=N/A" vì không rõ kích thước
 *    output, khiến ngưỡng bitrate không bao giờ được so sánh — đã kiểm chứng và sửa).
 *  - Output 2 (`-f null -`): decode thật để bắt cảnh báo lỗi giải mã (continuity/corrupt...)
 *    phục vụ ước lượng packet-loss.
 * Cả 2 output chỉ đọc network MỘT lần (không fetch trùng lặp), và `-t` được lặp lại riêng
 * cho từng output — nếu chỉ đặt một lần cho output đầu, output còn lại sẽ chạy không giới hạn
 * thời gian và làm treo tiến trình (đã kiểm chứng thực tế trước khi sửa).
 */
function measureTrack(
  url: string,
  mapSelector: string,
  durationSeconds: number,
  timeoutSeconds: number
): Promise<TrackMeasurement> {
  return new Promise((resolve, reject) => {
    const args = [
      "-nostdin",
      "-hide_banner",
      "-i",
      url,
      "-t",
      String(durationSeconds),
      "-map",
      mapSelector,
      "-c",
      "copy",
      "-f",
      "mpegts",
      "pipe:1",
      "-t",
      String(durationSeconds),
      "-map",
      mapSelector,
      "-f",
      "null",
      "-",
    ];

    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let totalBytes = 0;
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Không khởi chạy được ffmpeg: ${err.message}`));
    });

    child.on("close", () => {
      clearTimeout(timer);

      if (/matches no streams|does not contain any stream/i.test(stderr)) {
        resolve({ ...EMPTY_MEASUREMENT });
        return;
      }

      if (timedOut && totalBytes === 0) {
        reject(new Error(`ffmpeg timeout sau ${timeoutSeconds}s khi đo track (${mapSelector})`));
        return;
      }

      // Bitrate PHẢI tính theo thời lượng NỘI DUNG (PTS), không phải thời gian tải mạng thực tế:
      // CDN/edge cache thường trả segment nhanh hơn nhiều so với tốc độ phát thực (speed=10-20x),
      // nên chia cho wall-clock time sẽ thổi phồng bitrate sai lệch nghiêm trọng. Ưu tiên lấy
      // trực tiếp "bitrate=" mà ffmpeg tự tính (dựa trên size/time nội dung của output copy);
      // chỉ fallback sang tự tính bytes/content-time khi ffmpeg trả "N/A" (một số trường hợp hiếm).
      const bitrateMatches = [...stderr.matchAll(/bitrate=\s*([\d.]+)\s*kbits\/s/gi)];
      const lastBitrateMatch = bitrateMatches.length > 0 ? bitrateMatches[bitrateMatches.length - 1] : null;

      const timeMatches = [...stderr.matchAll(/time=\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/gi)];
      const lastTimeMatch = timeMatches.length > 0 ? timeMatches[timeMatches.length - 1] : null;
      const contentSeconds = lastTimeMatch
        ? Number(lastTimeMatch[1]) * 3600 + Number(lastTimeMatch[2]) * 60 + Number(lastTimeMatch[3]) + Number(lastTimeMatch[4]) / 100
        : 0;

      let bitrateKbps: number | null = lastBitrateMatch ? parseFloat(lastBitrateMatch[1]) : null;
      if (bitrateKbps === null && totalBytes > 0 && contentSeconds > 0) {
        bitrateKbps = (totalBytes * 8) / (contentSeconds * 1000);
      }

      const frameMatches = [...stderr.matchAll(/frame=\s*(\d+)/gi)];
      const lastFrameMatch = frameMatches.length > 0 ? frameMatches[frameMatches.length - 1] : null;

      const sampleCount = lastFrameMatch
        ? parseInt(lastFrameMatch[1], 10)
        : (stderr.match(/time=\s*\d{2}:\d{2}:\d{2}\.\d{2}/gi) || []).length;

      const errorCount = (stderr.match(new RegExp(DECODE_ERROR_PATTERN, "gi")) || []).length;

      resolve({ bitrateKbps, sampleCount, errorCount, streamMissing: false });
    });
  });
}

export interface AnalyzeStreamParams {
  streamName: string;
  videoUrl: string;
  ffprobeDurationSeconds: number;
  timeoutSeconds: number;
  /** URL playlist audio riêng biệt (EXT-X-MEDIA), nếu master playlist tách audio khỏi video variant. */
  audioUrl?: string;
  /** false đối với luồng Radio: bỏ qua hoàn toàn việc decode/đo bitrate video. */
  probeVideo?: boolean;
  /** Nếu thực thi lâu hơn ngưỡng này (dù thành công), log cảnh báo nghẽn (bottleneck) vào diagnostic.log. */
  slowThresholdMs?: number;
}

async function analyzeStreamInternal(params: AnalyzeStreamParams): Promise<AvAnalysisResult> {
  const { streamName, videoUrl, ffprobeDurationSeconds, timeoutSeconds, audioUrl, probeVideo = true } = params;
  const startedAt = Date.now();

  try {
    const videoMetadata = await probeMetadata(videoUrl, timeoutSeconds);
    const audioMetadata = audioUrl ? await probeMetadata(audioUrl, timeoutSeconds) : videoMetadata;

    const hasAudio = audioUrl ? audioMetadata.hasAudio : videoMetadata.hasAudio;
    const audioSourceUrl = audioUrl ?? videoUrl;

    const [videoMeasurement, audioMeasurement] = await Promise.all([
      probeVideo && videoMetadata.hasVideo
        ? measureTrack(videoUrl, "0:v:0", ffprobeDurationSeconds, timeoutSeconds)
        : Promise.resolve<TrackMeasurement>({ ...EMPTY_MEASUREMENT }),
      hasAudio
        ? measureTrack(audioSourceUrl, "0:a:0", ffprobeDurationSeconds, timeoutSeconds)
        : Promise.resolve<TrackMeasurement>({ ...EMPTY_MEASUREMENT }),
    ]);

    // Dùng track video làm cơ sở tính packet-loss nếu luồng có/được yêu cầu video (TV);
    // ngược lại (Radio, hoặc TV mất video) rơi về dùng track audio làm cơ sở.
    const packetLossBasis =
      probeVideo && videoMetadata.hasVideo && videoMeasurement.sampleCount > 0 ? videoMeasurement : audioMeasurement;

    const packetLossPercentage =
      packetLossBasis.sampleCount > 0
        ? Math.min(100, (packetLossBasis.errorCount / packetLossBasis.sampleCount) * 100)
        : 0;

    const executionMs = Date.now() - startedAt;
    if (params.slowThresholdMs && executionMs > params.slowThresholdMs) {
      logDiagnostic("ffprobe_bottleneck", {
        stream: streamName,
        executionMs,
        slowThresholdMs: params.slowThresholdMs,
        queueStats: getFfprobeQueueStats(),
      });
      log.warn(`Level 3 cho luồng ${streamName} chạy chậm bất thường (${executionMs}ms) - nghi ngờ nghẽn queue/CPU`, {
        executionMs,
      });
    }

    return {
      hasVideo: probeVideo && videoMetadata.hasVideo,
      hasAudio,
      videoCodec: probeVideo ? videoMetadata.videoCodec : null,
      audioCodec: audioMetadata.audioCodec,
      videoBitrateKbps: videoMeasurement.bitrateKbps,
      audioBitrateKbps: audioMeasurement.bitrateKbps,
      packetLossPercentage,
      executionMs,
    };
  } catch (err) {
    const executionMs = Date.now() - startedAt;
    const message = (err as Error).message;
    const timedOut = /timeout/i.test(message);

    logDiagnostic("ffprobe_error", { stream: streamName, executionMs, timedOut, error: message });
    log.warn("Lỗi khi phân tích AV bằng ffprobe/ffmpeg", { streamName, videoUrl, audioUrl, error: message, timedOut });

    return {
      hasVideo: false,
      hasAudio: false,
      videoCodec: null,
      audioCodec: null,
      videoBitrateKbps: null,
      audioBitrateKbps: null,
      packetLossPercentage: 0,
      error: message,
      timedOut,
      executionMs,
    };
  }
}

/**
 * Level 3: Kiểm tra sâu chất lượng AV bằng ffprobe/ffmpeg.
 * Đọc trực tiếp luồng trong vài giây, trả về bitrate thực tế video/audio,
 * codec, tình trạng thiếu track, và tỉ lệ lỗi giải mã (packet loss heuristic).
 *
 * Toàn bộ lệnh gọi được xếp qua `ffprobeQueue` (xem `configureFfprobeConcurrency`) - luồng
 * nào đến sau khi queue đã đầy sẽ CHỜ, không chạy song song vô hạn.
 */
export function analyzeStream(params: AnalyzeStreamParams): Promise<AvAnalysisResult> {
  return ffprobeQueue.add(() => analyzeStreamInternal(params)) as Promise<AvAnalysisResult>;
}
