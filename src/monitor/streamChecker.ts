import type { AppConfig, StreamConfig, StreamCheckResult, HealthStatus } from "../types";
import { checkManifest } from "./manifestChecker";
import { checkFreeze } from "./freezeChecker";
import { analyzeStream } from "../ffmpeg/ffprobe";
import { getState } from "./stateStore";

/**
 * Thực hiện đầy đủ Level 1 -> 2 -> 3 cho MỘT lần kiểm tra của một luồng, trả về kết quả thô.
 * Hàm này THUẦN (pure) về mặt state/alert: không quyết định gửi Telegram, không cập nhật
 * StreamRuntimeState - việc đó thuộc về `incidentManager.ts` để có thể tái sử dụng hàm này
 * cho cả lần kiểm tra định kỳ lẫn các lần retry trong cơ chế debounce/suspect.
 */
export async function checkStream(stream: StreamConfig, config: AppConfig): Promise<StreamCheckResult> {
  const previousState = getState(stream.name);
  const issues: string[] = [];

  const manifest = await checkManifest(stream.url, config.timeoutSeconds);

  if (!manifest.ok || !manifest.manifest) {
    return {
      streamName: stream.name,
      checkedAt: new Date(),
      status: "DOWN",
      issues: [manifest.error || "Không truy cập được manifest"],
      manifest,
    };
  }

  if (manifest.latencyMs > config.thresholds.maxManifestLatencyMs) {
    issues.push(
      `Độ trễ manifest cao: ${manifest.latencyMs}ms (ngưỡng ${config.thresholds.maxManifestLatencyMs}ms)`
    );
  }

  const freeze = checkFreeze(manifest.manifest, previousState);
  if (freeze.frozen) {
    issues.push(
      `Luồng có dấu hiệu đóng băng: media-sequence (${freeze.mediaSequence ?? "N/A"}) và segment cuối không đổi qua 2 lần kiểm tra`
    );
  }

  // Level 1/2 đã đủ để kết luận DEGRADED (đóng băng, hoặc độ trễ manifest vượt ngưỡng) -> bỏ qua
  // Level 3. Hai lý do: (1) không lãng phí 1 slot hostQueue/ffprobeQueue (tài nguyên bị origin giới
  // hạn nghiêm ngặt) để đo bitrate của 1 luồng đã biết chắc là lỗi; (2) quan trọng hơn - nếu vẫn chờ
  // Level 3, MỌI lần retry trong chu trình SUSPECT (incidentManager gọi lại checkStream) cũng phải
  // xếp hàng chờ ffprobe, khiến watchdog kích hoạt sớm (runFastProbe) mất hết ý nghĩa: đã tái hiện
  // thực tế người dùng vẫn phải đợi gần bằng thời gian cũ dù watchdog đã phát hiện đúng và nhanh,
  // vì bản thân runCheck() bị nghẽn lại ở bước Level 3 phía sau.
  if (issues.length > 0) {
    return {
      streamName: stream.name,
      checkedAt: new Date(),
      status: "DEGRADED",
      issues,
      manifest,
      freeze,
    };
  }

  const isRadio = stream.type === "radio";

  const av = await analyzeStream({
    streamName: stream.name,
    videoUrl: manifest.resolvedUrl,
    ffprobeDurationSeconds: config.ffprobeDurationSeconds,
    timeoutSeconds: config.timeoutSeconds,
    audioUrl: manifest.resolvedAudioUrl,
    probeVideo: !isRadio,
    slowThresholdMs: config.diagnostics.ffprobeSlowThresholdMs,
  });

  if (av.error) {
    issues.push(`Không phân tích được chất lượng AV: ${av.error}`);
  } else {
    if (!isRadio) {
      if (!av.hasVideo) {
        issues.push("Mất track Video");
      } else if (av.videoBitrateKbps !== null && av.videoBitrateKbps < config.thresholds.minVideoBitrateKbps) {
        issues.push(
          `Bitrate video thực tế (${av.videoBitrateKbps.toFixed(0)}kbps) < Ngưỡng (${config.thresholds.minVideoBitrateKbps}kbps)`
        );
      }
    }

    if (!av.hasAudio) {
      issues.push("Mất track Audio");
    } else if (av.audioBitrateKbps !== null && av.audioBitrateKbps < config.thresholds.minAudioBitrateKbps) {
      issues.push(
        `Bitrate audio thực tế (${av.audioBitrateKbps.toFixed(0)}kbps) < Ngưỡng (${config.thresholds.minAudioBitrateKbps}kbps)`
      );
    }

    if (av.packetLossPercentage > config.thresholds.maxPacketLossPercentage) {
      issues.push(
        `Tỉ lệ lỗi/rớt gói tin (${av.packetLossPercentage.toFixed(2)}%) > Ngưỡng (${config.thresholds.maxPacketLossPercentage}%)`
      );
    }
  }

  const status: HealthStatus = issues.length === 0 ? "OK" : "DEGRADED";

  return {
    streamName: stream.name,
    checkedAt: new Date(),
    status,
    issues,
    manifest,
    freeze,
    av,
  };
}
