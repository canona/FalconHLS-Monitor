import type { AppConfig, StreamConfig, StreamCheckResult, ErrorCategory } from "../types";
import { getState, setState, setLastResult } from "./stateStore";
import { classifyError, snapshotDiagnostics, ERROR_CATEGORY_LABEL } from "./errorClassifier";
import { enqueueAlert } from "../telegram/alertManager";
import { sendTelegramMessage, buildRecoveryMessage } from "../telegram/telegramBot";
import { logDiagnostic } from "../logger/diagnosticLogger";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("incident-manager");

/** Số lần liên tiếp bị phân loại SYSTEM_OVERLOAD trước khi bỏ cuộc (không escalate, chỉ log) - chống lặp vô hạn. */
const MAX_OVERLOAD_SKIPS = 3;
const overloadStreak = new Map<string, number>();

export type RecheckFn = (stream: StreamConfig) => void;

/**
 * Nhận kết quả của MỘT lần kiểm tra thô (từ scheduler định kỳ hoặc từ 1 lần retry), quyết định:
 * - OK: reset về STABLE, gửi phục hồi nếu trước đó đã từng confirmed lỗi.
 * - SYSTEM_OVERLOAD: bỏ qua hoàn toàn (không tính vào retry, không alert) - chỉ log server-level.
 * - NETWORK/STREAM: đưa vào (hoặc giữ trong) SUSPECT, lên lịch retry qua `recheck`; sau đủ
 *   `config.retry.maxRetries` lần liên tiếp thất bại mới escalate và đẩy sang AlertManager.
 */
export function processCheckResult(
  stream: StreamConfig,
  config: AppConfig,
  result: StreamCheckResult,
  recheck: RecheckFn
): void {
  const now = result.checkedAt;
  const state = getState(stream.name);

  setLastResult(stream.name, result);

  const baseUpdate = {
    lastMediaSequence: result.freeze?.mediaSequence ?? state.lastMediaSequence,
    lastSegmentUri: result.freeze?.lastSegmentUri ?? state.lastSegmentUri,
    lastManifestChangeAt: result.freeze?.frozen ? state.lastManifestChangeAt : now,
    lastCheckedAt: now,
  };

  if (result.status === "OK") {
    overloadStreak.delete(stream.name);

    if (state.pendingRetryTimer) clearTimeout(state.pendingRetryTimer);

    const wasConfirmedBad = state.lastStatus !== "OK";
    if (wasConfirmedBad) {
      void sendTelegramMessage(buildRecoveryMessage(result));
      logDiagnostic("stream_recovered", { stream: stream.name, previousStatus: state.lastStatus });
      log.info(`Luồng ${stream.name} đã phục hồi`);
    }

    setState(stream.name, {
      ...state,
      ...baseUpdate,
      lastStatus: "OK",
      phase: "STABLE",
      suspectAttempt: 0,
      suspectSince: null,
      pendingRetryTimer: null,
      lastAlertAt: wasConfirmedBad ? null : state.lastAlertAt,
      consecutiveFailures: 0,
    });
    return;
  }

  // result.status là DEGRADED hoặc DOWN (verdict thô của riêng lần check này)
  const diag = snapshotDiagnostics(config.diagnostics);
  const category: ErrorCategory = classifyError(result, diag);

  logDiagnostic("check_failed", {
    stream: stream.name,
    status: result.status,
    category,
    issues: result.issues,
    phase: state.phase,
    suspectAttempt: state.suspectAttempt,
    eventLoopLagMs: diag.eventLoopLagMs,
    heapUsedRatio: Number(diag.heapUsedRatio.toFixed(3)),
    executionMs: result.av?.executionMs,
    timedOut: result.av?.timedOut ?? false,
  });

  if (category === "SYSTEM_OVERLOAD") {
    const skips = (overloadStreak.get(stream.name) ?? 0) + 1;
    overloadStreak.set(stream.name, skips);

    log.warn(
      `[QUÁ TẢI] Bỏ qua kết quả kiểm tra luồng ${stream.name} do nghi ngờ hệ thống giám sát quá tải (không gửi Telegram)`,
      { eventLoopLagMs: diag.eventLoopLagMs, heapUsedRatio: diag.heapUsedRatio, timedOut: result.av?.timedOut }
    );

    setState(stream.name, { ...state, ...baseUpdate });

    if (skips >= MAX_OVERLOAD_SKIPS) {
      // Quá tải dai dẳng - không thể có kết quả tin cậy, dừng hẳn chu trình retry cho lần này
      // để tránh vòng lặp vô hạn; luồng sẽ được kiểm tra lại ở chu kỳ interval bình thường tiếp theo.
      overloadStreak.delete(stream.name);
      logDiagnostic("overload_giveup", { stream: stream.name, skips });
      setState(stream.name, {
        ...getState(stream.name),
        phase: "STABLE",
        suspectAttempt: 0,
        pendingRetryTimer: null,
      });
      return;
    }

    // Thử lại ở cùng bậc delay (không tính là 1 lần thất bại thật) để không lãng phí chu kỳ interval.
    const delay = config.retry.retryDelaysMs[0];
    scheduleRetry(stream, delay, recheck);
    return;
  }

  // NETWORK hoặc STREAM -> đi vào/tiếp tục chu trình SUSPECT
  const attempt = state.phase === "SUSPECT" ? state.suspectAttempt + 1 : 1;

  if (attempt < config.retry.maxRetries) {
    setState(stream.name, {
      ...state,
      ...baseUpdate,
      phase: "SUSPECT",
      suspectAttempt: attempt,
      suspectSince: state.suspectSince ?? now,
    });

    const delay = config.retry.retryDelaysMs[attempt - 1] ?? config.retry.retryDelaysMs[config.retry.retryDelaysMs.length - 1];
    logDiagnostic("suspect_retry_scheduled", {
      stream: stream.name,
      attempt,
      maxRetries: config.retry.maxRetries,
      delayMs: delay,
      category,
      issues: result.issues,
    });
    scheduleRetry(stream, delay, recheck);
    return;
  }

  // Đã thất bại đủ `maxRetries` lần liên tiếp -> xác nhận sự cố thật, chuẩn bị alert
  const cooldownMs = config.cooldownMinutes * 60_000;
  const cooldownElapsed = !state.lastAlertAt || now.getTime() - state.lastAlertAt.getTime() >= cooldownMs;

  setState(stream.name, {
    ...state,
    ...baseUpdate,
    lastStatus: result.status,
    phase: "STABLE",
    suspectAttempt: 0,
    suspectSince: null,
    pendingRetryTimer: null,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastAlertAt: cooldownElapsed ? now : state.lastAlertAt,
  });

  logDiagnostic("incident_confirmed", {
    stream: stream.name,
    status: result.status,
    category,
    attempts: attempt,
    willAlert: cooldownElapsed,
    issues: result.issues,
  });

  if (cooldownElapsed) {
    log.warn(`Xác nhận sự cố cho luồng ${stream.name} sau ${attempt} lần kiểm tra: ${ERROR_CATEGORY_LABEL[category]}`, {
      status: result.status,
      issues: result.issues,
    });
    enqueueAlert({
      streamName: stream.name,
      status: result.status,
      category,
      issues: result.issues,
      checkedAt: now,
      attempts: attempt,
    });
  } else {
    log.info(`Luồng ${stream.name} vẫn lỗi nhưng đang trong cooldown, không gửi lại cảnh báo`, {
      status: result.status,
    });
  }
}

function scheduleRetry(stream: StreamConfig, delayMs: number, recheck: RecheckFn): void {
  const state = getState(stream.name);
  if (state.pendingRetryTimer) clearTimeout(state.pendingRetryTimer);

  const timer = setTimeout(() => recheck(stream), delayMs);
  timer.unref();

  setState(stream.name, { ...getState(stream.name), pendingRetryTimer: timer });
}
