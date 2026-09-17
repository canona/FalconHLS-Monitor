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

/**
 * Giới hạn số kết nối TCP đồng thời tới CÙNG một origin (hostname), ĐỘC LẬP với `ffprobeQueue`
 * tổng. Nhiều kênh khác nhau nhưng dùng chung 1 origin (rất phổ biến - VD nhiều đài truyền hình
 * cùng phát qua 1 hạ tầng CDN/catchup) có thể khiến origin (hoặc WAF/anti-leech phía trước nó) coi
 * nhiều kết nối ngắn dồn dập từ CÙNG 1 IP giám sát là traffic bất thường và tạm thời rate-limit/
 * timeout kết nối - dù nội dung stream với người xem thật hoàn toàn bình thường. `analyzeStream()`
 * phải xin "vé" ở CẢ 2 hàng đợi (theo host lẫn theo tổng) trước khi thực sự chạy ffmpeg/ffprobe.
 */
let hostConcurrencyLimit = 2;
const hostQueues = new Map<string, PQueue>();

export function configureHostConcurrency(limit: number): void {
  hostConcurrencyLimit = limit;
  hostQueues.clear();
}

function getHostQueue(hostname: string): PQueue {
  let queue = hostQueues.get(hostname);
  if (!queue) {
    queue = new PQueue({ concurrency: hostConcurrencyLimit });
    hostQueues.set(hostname, queue);
  }
  return queue;
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown-host";
  }
}

/**
 * Đánh dấu RIÊNG trường hợp CHÍNH TA chủ động SIGKILL tiến trình vì nó không phản hồi trong
 * `timeoutSeconds` (dấu hiệu worker/queue giám sát quá tải) - phân biệt rạch ròi với việc ffmpeg TỰ
 * thoát do lỗi kết nối tới origin (VD "Operation timed out" khi bị WAF/origin rate-limit). Trước
 * đây cả 2 trường hợp đều được nhận diện chỉ bằng cách dò chữ "timeout" trong message, khiến lỗi
 * kết nối origin (chứa "timed out") có nguy cơ bị gộp nhầm vào "quá tải hệ thống giám sát"
 * (SYSTEM_OVERLOAD - im lặng bỏ qua, không alert) thay vì được xử lý đúng như NETWORK (có retry
 * với backoff riêng, xem incidentManager.ts). Dùng `instanceof` thay vì regex trên message để loại
 * bỏ hoàn toàn sự mơ hồ về câu chữ.
 */
class WorkerTimeoutError extends Error {}

interface TrackMeasurement {
  bitrateKbps: number | null;
  /** Số frame video (khi có "frame=" trong stats) hoặc số tick tiến trình (fallback cho audio-only). */
  sampleCount: number;
  errorCount: number;
  streamMissing: boolean;
  /** Tên codec đọc trực tiếp từ banner "Input #0 ... Stream #0:x: <Video|Audio>: <codec>" của chính
   *  tiến trình ffmpeg này - KHÔNG cần chạy ffprobe riêng để lấy metadata (xem measureTrack). */
  codec: string | null;
}

const DECODE_ERROR_PATTERN =
  /(continuity count error|continuity check failed|corrupt|missing picture in access unit|concealing \d+ dc|error while decoding|invalid data found when processing input|non-monotonic dts)/i;

const EMPTY_MEASUREMENT: TrackMeasurement = {
  bitrateKbps: null,
  sampleCount: 0,
  errorCount: 0,
  streamMissing: true,
  codec: null,
};

type TrackKind = "video" | "audio";

/**
 * ffmpeg luôn in banner liệt kê MỌI stream có trong input khi mở file (bất kể `-map` chọn track
 * nào để xuất) - VD "Stream #0:0: Video: h264 ...", "Stream #0:1: Audio: aac ...". Tận dụng banner
 * này để suy ra codec/sự tồn tại của track, thay vì phải chạy thêm 1 tiến trình ffprobe riêng chỉ
 * để đọc metadata - giảm một nửa số kết nối TCP ra origin cho mỗi lần kiểm tra Level 3.
 */
const STREAM_CODEC_PATTERN: Record<TrackKind, RegExp> = {
  video: /Stream #\d+:\d+[^:]*:\s*Video:\s*([A-Za-z0-9_]+)/i,
  audio: /Stream #\d+:\d+[^:]*:\s*Audio:\s*([A-Za-z0-9_]+)/i,
};

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
  trackKind: TrackKind,
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

    child.on("close", (code) => {
      clearTimeout(timer);

      if (/matches no streams|does not contain any stream/i.test(stderr)) {
        resolve({ ...EMPTY_MEASUREMENT });
        return;
      }

      if (timedOut && totalBytes === 0) {
        reject(new WorkerTimeoutError(`ffmpeg timeout sau ${timeoutSeconds}s khi đo track (${mapSelector})`));
        return;
      }

      // ffmpeg tự thoát lỗi (không phải do ta SIGKILL) TRƯỚC KHI tải được byte nào - thường là lỗi
      // kết nối tới origin (DNS, TCP connect timeout, TLS, HTTP 4xx/5xx...) hoặc lỗi mở input. Phải
      // ném lỗi ở đây thay vì âm thầm chạy tiếp xuống dưới, nếu không sẽ resolve một measurement
      // rỗng (bitrate null, không track) và bị hiểu nhầm thành "mất track" thay vì "lỗi mạng".
      if (code !== 0 && totalBytes === 0) {
        reject(new Error(`ffmpeg lỗi khi mở luồng (exit ${code}): ${stderr.trim().slice(0, 300)}`));
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

      const codecMatch = stderr.match(STREAM_CODEC_PATTERN[trackKind]);
      const codec = codecMatch ? codecMatch[1] : null;

      resolve({ bitrateKbps, sampleCount, errorCount, streamMissing: false, codec });
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
    const audioSourceUrl = audioUrl ?? videoUrl;

    // Không còn bước probeMetadata (ffprobe) riêng: measureTrack tự suy ra track có tồn tại hay
    // không (qua "matches no streams" trong stderr) và đọc codec trực tiếp từ banner ffmpeg -
    // gộp "đọc metadata" + "đo bitrate/lỗi giải mã" vào ĐÚNG 1 tiến trình/1 kết nối cho mỗi track,
    // thay vì 1 ffprobe (metadata) + 1 ffmpeg (đo) riêng biệt như trước. Giảm ~50% số kết nối TCP
    // ra origin cho mỗi lần kiểm tra Level 3 - nguyên nhân chính gây origin rate-limit khi giám sát
    // nhiều kênh cùng chung 1 origin.
    const [videoMeasurement, audioMeasurement] = await Promise.all([
      probeVideo
        ? measureTrack(videoUrl, "0:v:0", "video", ffprobeDurationSeconds, timeoutSeconds)
        : Promise.resolve<TrackMeasurement>({ ...EMPTY_MEASUREMENT }),
      measureTrack(audioSourceUrl, "0:a:0", "audio", ffprobeDurationSeconds, timeoutSeconds),
    ]);

    const hasVideo = probeVideo && !videoMeasurement.streamMissing;
    const hasAudio = !audioMeasurement.streamMissing;

    // Dùng track video làm cơ sở tính packet-loss nếu luồng có/được yêu cầu video (TV);
    // ngược lại (Radio, hoặc TV mất video) rơi về dùng track audio làm cơ sở.
    const packetLossBasis = hasVideo && videoMeasurement.sampleCount > 0 ? videoMeasurement : audioMeasurement;

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
      hasVideo,
      hasAudio,
      videoCodec: videoMeasurement.codec,
      audioCodec: audioMeasurement.codec,
      videoBitrateKbps: videoMeasurement.bitrateKbps,
      audioBitrateKbps: audioMeasurement.bitrateKbps,
      packetLossPercentage,
      executionMs,
    };
  } catch (err) {
    const executionMs = Date.now() - startedAt;
    const message = (err as Error).message;
    // CHỈ true khi CHÍNH TA chủ động SIGKILL do worker không phản hồi kịp (xem WorkerTimeoutError) -
    // lỗi ffmpeg tự báo "Operation timed out" khi không kết nối được tới origin KHÔNG rơi vào đây,
    // mà được phân loại qua NETWORK_ERROR_PATTERN (errorClassifier.ts) để đi đúng luồng NETWORK.
    const timedOut = err instanceof WorkerTimeoutError;

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
 * Phải xin "vé" ở CẢ 2 hàng đợi trước khi thực sự chạy: `getHostQueue` (giới hạn kết nối đồng thời
 * tới CÙNG origin - xem `configureHostConcurrency`) và `ffprobeQueue` (giới hạn tổng số tiến trình
 * Level 3 trên toàn hệ thống - xem `configureFfprobeConcurrency`). Luồng nào đến sau khi 1 trong 2
 * hàng đợi đã đầy sẽ CHỜ, không chạy song song vô hạn.
 */
export function analyzeStream(params: AnalyzeStreamParams): Promise<AvAnalysisResult> {
  const hostQueue = getHostQueue(extractHostname(params.videoUrl));
  return hostQueue.add(() => ffprobeQueue.add(() => analyzeStreamInternal(params))) as Promise<AvAnalysisResult>;
}
