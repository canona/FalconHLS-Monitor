import axios from "axios";
import { z } from "zod";
import type { PartnerCredential, StreamConfig } from "../types";
import { createChildLogger } from "../logger/logger";

const log = createChildLogger("partner-api-client");

// Cấu trúc THẬT của API VTVgo (GET .../api/public/channels, header Authorization: Bearer <token>) -
// xác nhận qua tài liệu "14 — Tích hợp VTVgo". Response bọc trong "channels" (KHÔNG phải "data"), mỗi
// kênh nhận diện DUY NHẤT qua "name" (partner không cấp id riêng), URL kéo luồng nằm sẵn ở field "hls"
// (đã gắn token ?pull=... không hết hạn, dùng thẳng - không cần tự ghép baseUrl/token).
//
// QUAN TRỌNG: API KHÔNG cung cấp loại luồng TV/Radio - mọi kênh từ Partner mặc định "tv". Nếu Partner
// có kênh radio thật, cần cơ chế nhận diện riêng (VD dò theo tên) - xem CLAUDE.md mục "Bẫy kỹ thuật" #19.
const PartnerApiChannelSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["RUNNING", "STOPPED", "ERROR"]),
  live: z.boolean(),
  hls: z.string().url(),
});

const PartnerApiResponseSchema = z.object({
  channels: z.array(z.unknown()),
});

/**
 * Gọi API 1 Partner, trả về danh sách StreamConfig đầy đủ (đã gắn partner/id). Validate TỪNG phần tử
 * riêng lẻ - 1 kênh sai format bị bỏ qua kèm log warning, không làm hỏng toàn bộ danh sách của Partner
 * đó. Chỉ lấy kênh `status === "RUNNING" && live === true` - kênh STOPPED/ERROR/live=false không có
 * playlist thật để giám sát, bỏ qua ÂM THẦM (không phải lỗi, là trạng thái vận hành bình thường).
 *
 * Lỗi HTTP/network/timeout/JSON không đúng cấu trúc top-level được THROW ra ngoài để caller
 * (streamSyncService) tự quyết định giữ nguyên danh sách cũ thay vì xóa sạch do 1 lần lỗi tạm thời.
 */
export async function fetchPartnerChannels(
  cred: PartnerCredential,
  baseUrl: string,
  timeoutMs: number
): Promise<StreamConfig[]> {
  const response = await axios.get(baseUrl, {
    headers: { Authorization: `Bearer ${cred.token}` },
    timeout: timeoutMs,
  });

  const parsed = PartnerApiResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Response của Partner "${cred.name}" không đúng cấu trúc mong đợi (thiếu "channels[]")`);
  }

  const streams: StreamConfig[] = [];

  for (const rawChannel of parsed.data.channels) {
    const result = PartnerApiChannelSchema.safeParse(rawChannel);
    if (!result.success) {
      log.warn(`Bỏ qua 1 kênh sai format từ Partner "${cred.name}"`, {
        issues: result.error.issues.map((i) => i.message),
      });
      continue;
    }

    const channel = result.data;
    if (channel.status !== "RUNNING" || !channel.live) continue;

    streams.push({
      name: channel.name,
      url: channel.hls,
      type: "tv",
      partner: cred.name,
      id: `${cred.name}:${channel.name}`,
    });
  }

  return streams;
}
