import axios from "axios";
import { parseM3U8, pickHighestBandwidthVariant, resolveUri, findAudioRenditionForVariant } from "./m3u8Parser";
import type { ManifestCheckResult } from "../types";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("manifest-checker");

/**
 * Level 1: Kiểm tra sức khỏe manifest.
 * - Gọi HTTP, đo latency, xác nhận HTTP 200.
 * - Parse nội dung m3u8; nếu là master playlist, tự động theo variant bandwidth cao nhất
 *   để lấy media playlist thực tế phục vụ kiểm tra Level 2/3.
 */
export async function checkManifest(url: string, timeoutSeconds: number): Promise<ManifestCheckResult> {
  const startedAt = Date.now();

  try {
    const response = await axios.get<string>(url, {
      timeout: timeoutSeconds * 1000,
      responseType: "text",
      validateStatus: () => true,
      headers: { "User-Agent": "StreamGuard-HLS-Monitor/1.0" },
    });

    const latencyMs = Date.now() - startedAt;

    if (response.status !== 200) {
      return {
        ok: false,
        httpStatus: response.status,
        latencyMs,
        error: `HTTP ${response.status} khi lấy manifest`,
        resolvedUrl: url,
      };
    }

    let manifest = parseM3U8(response.data);
    let resolvedUrl = url;

    if (manifest.isMaster) {
      const bestVariant = pickHighestBandwidthVariant(manifest);
      if (!bestVariant) {
        return {
          ok: false,
          httpStatus: response.status,
          latencyMs,
          error: "Master playlist không có variant nào hợp lệ",
          resolvedUrl: url,
        };
      }

      const variantUrl = resolveUri(url, bestVariant.uri);
      const audioRendition = findAudioRenditionForVariant(manifest, bestVariant);
      const resolvedAudioUrl = audioRendition ? resolveUri(url, audioRendition.uri) : undefined;

      log.debug("Master playlist phát hiện, chuyển sang theo dõi variant cao nhất", {
        variantUrl,
        bandwidth: bestVariant.bandwidth,
        resolvedAudioUrl,
      });

      const variantResponse = await axios.get<string>(variantUrl, {
        timeout: timeoutSeconds * 1000,
        responseType: "text",
        validateStatus: () => true,
        headers: { "User-Agent": "StreamGuard-HLS-Monitor/1.0" },
      });

      if (variantResponse.status !== 200) {
        return {
          ok: false,
          httpStatus: variantResponse.status,
          latencyMs: Date.now() - startedAt,
          error: `HTTP ${variantResponse.status} khi lấy variant playlist`,
          resolvedUrl: variantUrl,
        };
      }

      manifest = parseM3U8(variantResponse.data);
      resolvedUrl = variantUrl;

      return {
        ok: true,
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        manifest,
        resolvedUrl,
        resolvedAudioUrl,
      };
    }

    return {
      ok: true,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      manifest,
      resolvedUrl,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = axios.isAxiosError(err)
      ? err.code === "ECONNABORTED"
        ? `Timeout sau ${timeoutSeconds}s khi lấy manifest`
        : `Lỗi mạng: ${err.message}`
      : `Lỗi không xác định: ${(err as Error).message}`;

    return {
      ok: false,
      httpStatus: null,
      latencyMs,
      error: message,
      resolvedUrl: url,
    };
  }
}
