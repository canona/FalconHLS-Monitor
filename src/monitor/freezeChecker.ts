import type { ParsedManifest, FreezeCheckResult, StreamRuntimeState } from "../types";

/**
 * Level 2: Phát hiện đóng băng luồng Live.
 * So sánh media-sequence và segment cuối cùng với lần kiểm tra trước.
 * Nếu cả hai không đổi trên một luồng đang Live (không có #EXT-X-ENDLIST) => nghi ngờ treo luồng.
 */
export function checkFreeze(manifest: ParsedManifest, previousState: StreamRuntimeState): FreezeCheckResult {
  const isVod = manifest.endList;
  const lastSegment = manifest.segments[manifest.segments.length - 1] ?? null;
  const lastSegmentUri = lastSegment ? lastSegment.uri : null;

  if (isVod) {
    return {
      frozen: false,
      isVod: true,
      mediaSequence: manifest.mediaSequence,
      lastSegmentUri,
      segmentCount: manifest.segments.length,
    };
  }

  const hasPreviousData = previousState.lastMediaSequence !== null || previousState.lastSegmentUri !== null;

  const sameMediaSequence =
    hasPreviousData &&
    previousState.lastMediaSequence !== null &&
    manifest.mediaSequence !== null &&
    previousState.lastMediaSequence === manifest.mediaSequence;

  const sameSegment =
    hasPreviousData && previousState.lastSegmentUri !== null && previousState.lastSegmentUri === lastSegmentUri;

  const frozen = hasPreviousData && sameMediaSequence && sameSegment;

  return {
    frozen,
    isVod: false,
    mediaSequence: manifest.mediaSequence,
    lastSegmentUri,
    segmentCount: manifest.segments.length,
  };
}
