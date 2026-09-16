const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";

/**
 * Định dạng thời gian theo múi giờ Việt Nam (GMT+7) cố định, KHÔNG phụ thuộc vào
 * timezone của hệ điều hành/container (Coolify/Docker mặc định thường chạy UTC).
 */
export function formatVnTime(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (GMT+7)`;
}
