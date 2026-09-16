import type { AppConfig, StreamConfig, StreamCheckResult, HealthStatus } from "../types";
import { checkManifest } from "./manifestChecker";
import { checkFreeze } from "./freezeChecker";
import { analyzeStream } from "../ffmpeg/ffprobe";
import { getState, setState, setLastResult } from "./stateStore";
import { sendTelegramMessage, buildDegradedMessage, buildDownMessage, buildRecoveryMessage } from "../telegram/telegramBot";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("stream-checker");

/** Thực hiện đầy đủ Level 1 -> 2 -> 3 cho một luồng, cập nhật state và gửi cảnh báo nếu cần. */
export async function checkStream(stream: StreamConfig, config: AppConfig): Promise<StreamCheckResult> {
  const previousState = getState(stream.name);
  const issues: string[] = [];

  const manifest = await checkManifest(stream.url, config.timeoutSeconds);

  if (!manifest.ok || !manifest.manifest) {
    const result: StreamCheckResult = {
      streamName: stream.name,
      checkedAt: new Date(),
      status: "DOWN",
      issues: [manifest.error || "Không truy cập được manifest"],
      manifest,
    };
    await finalizeAndAlert(stream, result, previousState, config);
    return result;
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

  const isRadio = stream.type === "radio";

  const av = await analyzeStream(
    manifest.resolvedUrl,
    config.ffprobeDurationSeconds,
    config.timeoutSeconds,
    manifest.resolvedAudioUrl,
    !isRadio
  );

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

  const result: StreamCheckResult = {
    streamName: stream.name,
    checkedAt: new Date(),
    status,
    issues,
    manifest,
    freeze,
    av,
  };

  await finalizeAndAlert(stream, result, previousState, config);
  return result;
}

async function finalizeAndAlert(
  stream: StreamConfig,
  result: StreamCheckResult,
  previousState: ReturnType<typeof getState>,
  config: AppConfig
): Promise<void> {
  const now = result.checkedAt;
  const cooldownMs = config.cooldownMinutes * 60_000;

  const wasHealthy = previousState.lastStatus === "OK";
  const isHealthy = result.status === "OK";

  let lastAlertAt = previousState.lastAlertAt;

  if (!isHealthy) {
    const cooldownElapsed = !lastAlertAt || now.getTime() - lastAlertAt.getTime() >= cooldownMs;

    if (wasHealthy || cooldownElapsed) {
      const message = result.status === "DOWN" ? buildDownMessage(result) : buildDegradedMessage(result);
      await sendTelegramMessage(message);
      lastAlertAt = now;
      log.warn(`Cảnh báo đã gửi cho luồng ${stream.name}`, { status: result.status, issues: result.issues });
    }
  } else if (!wasHealthy) {
    await sendTelegramMessage(buildRecoveryMessage(result));
    lastAlertAt = null;
    log.info(`Luồng ${stream.name} đã phục hồi`);
  }

  setState(stream.name, {
    lastStatus: result.status,
    lastAlertAt,
    lastMediaSequence: result.freeze?.mediaSequence ?? previousState.lastMediaSequence,
    lastSegmentUri: result.freeze?.lastSegmentUri ?? previousState.lastSegmentUri,
    lastManifestChangeAt: result.freeze?.frozen ? previousState.lastManifestChangeAt : now,
    lastCheckedAt: now,
    consecutiveFailures: isHealthy ? 0 : previousState.consecutiveFailures + 1,
  });

  setLastResult(stream.name, result);
}
