import type { StaticStreamConfig, StreamConfig } from "../types";

/**
 * Nguồn sự thật DUY NHẤT cho danh sách luồng đang giám sát - thay thế vai trò của `config.streams`
 * tĩnh cũ. Gồm luồng khai báo tay (`partner: "static"`) + luồng đồng bộ định kỳ từ Partner API.
 * Khóa theo `id` (= `${partner}:${name}`), KHÔNG theo `name` vì tên kênh có thể trùng giữa 2 Partner.
 */
const streams = new Map<string, StreamConfig>();

export function setStaticStreams(staticStreams: StaticStreamConfig[]): void {
  for (const s of staticStreams) {
    const id = `static:${s.name}`;
    streams.set(id, { ...s, partner: "static", id });
  }
}

/**
 * Thay thế TOÀN BỘ luồng thuộc 1 Partner bằng danh sách mới nhất từ lần sync này, diff theo `id` so
 * với lần trước để trả về phần thêm/bớt cho caller đồng bộ scheduler + stateStore. Chỉ gọi khi sync
 * THÀNH CÔNG - nếu 1 lần sync lỗi, giữ nguyên danh sách cũ của Partner đó (không gọi hàm này).
 *
 * Kênh có CÙNG `id` nhưng `url` (hoặc `type`) đã đổi (VD VTVgo xoay `VTC_HLS_SECRET` sinh token `pull`
 * mới cho URL kéo luồng - xem tài liệu tích hợp VTVgo mục "Xoay secret") được coi như GỠ bản cũ + THÊM
 * bản mới, để `scheduler.addStreams` (vốn bỏ qua id đã tồn tại) không kẹt lại URL cũ vĩnh viễn.
 */
export function replacePartnerStreams(
  partnerName: string,
  newStreams: StreamConfig[]
): { added: StreamConfig[]; removed: StreamConfig[] } {
  const previous = new Map(
    Array.from(streams.values())
      .filter((s) => s.partner === partnerName)
      .map((s) => [s.id, s] as const)
  );

  const added: StreamConfig[] = [];
  const removed: StreamConfig[] = [];

  for (const s of newStreams) {
    const prev = previous.get(s.id);
    if (!prev) {
      added.push(s);
    } else if (prev.url !== s.url || prev.type !== s.type) {
      removed.push(prev);
      added.push(s);
    }
    previous.delete(s.id);
  }
  // Còn lại trong `previous` = kênh của Partner này đã biến mất khỏi lần sync hiện tại.
  removed.push(...previous.values());

  for (const s of removed) streams.delete(s.id);
  for (const s of newStreams) streams.set(s.id, s);

  return { added, removed };
}

export function getStreams(): StreamConfig[] {
  return Array.from(streams.values());
}

export function getStream(id: string): StreamConfig | undefined {
  return streams.get(id);
}
