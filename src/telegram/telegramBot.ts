import axios from "axios";
import { createChildLogger } from "../logger/logger";
import { formatVnTime } from "../utils/time";
import type { AlertIncident, StreamCheckResult } from "../types";

const log = createChildLogger("telegram-bot");

function getCredentials(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    log.error("Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong biến môi trường, không thể gửi cảnh báo");
    return null;
  }
  return { token, chatId };
}

/** Gửi tin nhắn Markdown tới Telegram. Không throw ra ngoài — lỗi mạng/API chỉ được log. */
export async function sendTelegramMessage(text: string): Promise<void> {
  const creds = getCredentials();
  if (!creds) return;

  const url = `https://api.telegram.org/bot${creds.token}/sendMessage`;

  try {
    await axios.post(
      url,
      {
        chat_id: creds.chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      },
      { timeout: 10_000 }
    );
  } catch (err) {
    const message = axios.isAxiosError(err) ? err.response?.data || err.message : (err as Error).message;
    log.error("Gửi tin nhắn Telegram thất bại", { error: message });
  }
}

export function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

const CATEGORY_LABEL: Record<AlertIncident["category"], string> = {
  SYSTEM_OVERLOAD: "Hệ thống giám sát quá tải",
  NETWORK: "Lỗi mạng / mất kết nối Origin-CDN",
  STREAM: "Lỗi luồng HLS thực sự",
};

/** Rút gọn issue đầu tiên của 1 luồng để hiển thị trong danh sách gộp (digest). */
function shortIssue(incident: AlertIncident): string {
  const first = incident.issues[0] || "Không rõ nguyên nhân";
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

export function buildIncidentMessage(incident: AlertIncident): string {
  const name = escapeMd(incident.streamName);
  const detailLines = incident.issues.map((issue) => `📉 *Chi tiết:* ${escapeMd(issue)}`).join("\n");
  const headline =
    incident.status === "DOWN" ? `Luồng *${name}* mất kết nối\\!` : `Luồng *${name}* bị suy giảm\\!`;

  return [
    `🔴 *CẢNH BÁO:* ${headline}`,
    `🏷 *Nguyên nhân:* ${escapeMd(CATEGORY_LABEL[incident.category])}`,
    detailLines,
    `🔁 Đã xác nhận sau ${incident.attempts} lần kiểm tra liên tiếp`,
    `🕐 Thời điểm: ${escapeMd(formatVnTime(incident.checkedAt))}`,
  ].join("\n");
}

/** Gộp nhiều sự cố xảy ra trong cùng 1 khung thời gian thành 1 tin nhắn duy nhất (chống spam diện rộng). */
export function buildDigestMessage(incidents: AlertIncident[]): string {
  const detail = incidents.map((i) => `${escapeMd(i.streamName)} \\(${escapeMd(shortIssue(i))}\\)`).join(", ");

  return [
    `🔴 *CẢNH BÁO DIỆN RỘNG \\(Gộp\\)*`,
    `Đang có ${incidents.length} luồng gặp sự cố cùng lúc\\.`,
    `📉 *Chi tiết:* ${detail}`,
    `🕐 Thời điểm: ${escapeMd(formatVnTime(incidents[0]?.checkedAt ?? new Date()))}`,
  ].join("\n");
}

export function buildRecoveryMessage(result: StreamCheckResult): string {
  const name = escapeMd(result.streamName);
  return [
    `🟢 *PHỤC HỒI:* Luồng *${name}* đã ổn định\\.`,
    `🕐 Thời điểm: ${escapeMd(formatVnTime(result.checkedAt))}`,
  ].join("\n");
}
