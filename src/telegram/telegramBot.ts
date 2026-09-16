import axios from "axios";
import { createChildLogger } from "../logger/logger";
import { formatVnTime } from "../utils/time";
import type { StreamCheckResult } from "../types";

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

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

export function buildDegradedMessage(result: StreamCheckResult): string {
  const name = escapeMd(result.streamName);
  const detailLines = result.issues.map((issue) => `📉 *Chi tiết:* ${escapeMd(issue)}`).join("\n");

  return [
    `🔴 *CẢNH BÁO:* Luồng *${name}* bị suy giảm\\!`,
    detailLines,
    `🕐 Thời điểm: ${escapeMd(formatVnTime(result.checkedAt))}`,
  ].join("\n");
}

export function buildDownMessage(result: StreamCheckResult): string {
  const name = escapeMd(result.streamName);
  const reason = escapeMd(result.manifest.error || "Không truy cập được manifest");

  return [
    `🔴 *CẢNH BÁO:* Luồng *${name}* mất kết nối\\!`,
    `📉 *Chi tiết:* ${reason}`,
    `🕐 Thời điểm: ${escapeMd(formatVnTime(result.checkedAt))}`,
  ].join("\n");
}

export function buildRecoveryMessage(result: StreamCheckResult): string {
  const name = escapeMd(result.streamName);
  return [
    `🟢 *PHỤC HỒI:* Luồng *${name}* đã ổn định\\.`,
    `🕐 Thời điểm: ${escapeMd(formatVnTime(result.checkedAt))}`,
  ].join("\n");
}
