import type { PartnerCredential } from "../types";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("partner-config");

const DEFAULT_PARTNER_API_BASE_URL = "https://catchup.vtcrd.top/api/public/channels";
const DEFAULT_SYNC_INTERVAL_SECONDS = 300;

/**
 * Parse VTC_PARTNER_KEYS="ten1:token1,ten2:token2" - cặp sai định dạng (thiếu ":", tên/token rỗng)
 * bị bỏ qua kèm log warning, KHÔNG throw để 1 cặp lỗi không làm sập toàn bộ hệ thống.
 */
export function loadPartnerCredentials(): PartnerCredential[] {
  const raw = process.env.VTC_PARTNER_KEYS;
  if (!raw || !raw.trim()) return [];

  const credentials: PartnerCredential[] = [];

  for (const rawPair of raw.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const sepIndex = pair.indexOf(":");
    const name = sepIndex >= 0 ? pair.slice(0, sepIndex).trim() : "";
    const token = sepIndex >= 0 ? pair.slice(sepIndex + 1).trim() : "";

    if (!name || !token) {
      log.warn(`Bỏ qua entry VTC_PARTNER_KEYS sai định dạng (cần "ten:token"): "${pair}"`);
      continue;
    }

    credentials.push({ name, token });
  }

  return credentials;
}

export function getPartnerApiBaseUrl(): string {
  return process.env.PARTNER_API_BASE_URL || DEFAULT_PARTNER_API_BASE_URL;
}

/**
 * Parse VTC_PARTNER_API_URLS="ten1:https://host1/api/channels,ten2:https://host2/api/channels" - cho
 * phép mỗi Partner trỏ tới 1 API riêng (khác hạ tầng, không chỉ khác token). Chưa có giao diện quản trị
 * để khai báo việc này, nên tạm cấu hình qua .env. Tách theo dấu `:` ĐẦU TIÊN (không split toàn bộ),
 * vì phần URL phía sau vẫn chứa `://` - không dùng `split(":")` sẽ cắt nhầm URL.
 */
export function loadPartnerApiUrls(): Map<string, string> {
  const raw = process.env.VTC_PARTNER_API_URLS;
  const overrides = new Map<string, string>();
  if (!raw || !raw.trim()) return overrides;

  for (const rawPair of raw.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const sepIndex = pair.indexOf(":");
    const name = sepIndex >= 0 ? pair.slice(0, sepIndex).trim() : "";
    const url = sepIndex >= 0 ? pair.slice(sepIndex + 1).trim() : "";

    if (!name || !url) {
      log.warn(`Bỏ qua entry VTC_PARTNER_API_URLS sai định dạng (cần "ten:url"): "${pair}"`);
      continue;
    }

    overrides.set(name, url);
  }

  return overrides;
}

/** URL API của 1 Partner cụ thể - ưu tiên override trong VTC_PARTNER_API_URLS, không có thì dùng
 *  PARTNER_API_BASE_URL/mặc định chung (phù hợp khi nhiều Partner cùng chung 1 hạ tầng, VD catchup.vtcrd.top). */
export function getPartnerApiUrl(partnerName: string, overrides: Map<string, string>): string {
  return overrides.get(partnerName) || getPartnerApiBaseUrl();
}

export function getPartnerSyncIntervalMs(): number {
  const raw = Number(process.env.PARTNER_SYNC_INTERVAL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_SECONDS;
  return seconds * 1000;
}
