import type { StreamConfig } from "../types";
import { loadPartnerCredentials, loadPartnerApiUrls, getPartnerApiUrl, getPartnerSyncIntervalMs } from "../config/partnerConfig";
import { fetchPartnerChannels } from "./partnerApiClient";
import { replacePartnerStreams } from "../monitor/streamRegistry";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("stream-sync");

const PARTNER_FETCH_TIMEOUT_MS = 10_000;

export type StreamChangeHandler = (added: StreamConfig[], removed: StreamConfig[]) => void;

/**
 * Sync worker: mỗi `PARTNER_SYNC_INTERVAL_SECONDS` (mặc định 5 phút), gọi API của TỪNG Partner khai
 * báo trong VTC_PARTNER_KEYS để lấy danh sách kênh mới nhất. 1 Partner lỗi tạm thời (timeout, 401,
 * response sai format) chỉ bị log - danh sách kênh CŨ của Partner đó vẫn được giữ nguyên, không bị
 * xóa sạch chỉ vì 1 lần sync thất bại.
 */
export async function startPartnerSync(onChange: StreamChangeHandler): Promise<{ stop: () => void }> {
  const credentials = loadPartnerCredentials();

  if (credentials.length === 0) {
    log.warn("Không có Partner nào được cấu hình trong VTC_PARTNER_KEYS - chỉ giám sát staticStreams (nếu có)");
    return { stop: () => {} };
  }

  // Đọc lại VTC_PARTNER_API_URLS ở mỗi lần sync (không cache) - cho phép đổi URL riêng của 1 Partner
  // qua .env rồi restart mà không cần sửa code, do CHƯA có giao diện quản trị khai báo việc này.
  const syncOnce = async (): Promise<void> => {
    const urlOverrides = loadPartnerApiUrls();
    const results = await Promise.allSettled(
      credentials.map((cred) =>
        fetchPartnerChannels(cred, getPartnerApiUrl(cred.name, urlOverrides), PARTNER_FETCH_TIMEOUT_MS)
      )
    );

    results.forEach((result, index) => {
      const cred = credentials[index];
      if (result.status === "rejected") {
        log.error(`Đồng bộ luồng từ Partner "${cred.name}" thất bại - giữ nguyên danh sách kênh cũ`, {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return;
      }

      const { added, removed } = replacePartnerStreams(cred.name, result.value);
      if (added.length > 0 || removed.length > 0) {
        log.info(`Partner "${cred.name}": +${added.length} kênh, -${removed.length} kênh`);
      }
      onChange(added, removed);
    });
  };

  await syncOnce();

  const interval = setInterval(() => {
    void syncOnce();
  }, getPartnerSyncIntervalMs());
  interval.unref();

  return {
    stop: () => clearInterval(interval),
  };
}
