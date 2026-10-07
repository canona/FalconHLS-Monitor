# HƯỚNG DẪN SỬ DỤNG — FalconHLS Monitor (StreamGuard HLS)

> Đối tượng: người vận hành giám sát luồng HLS (TV/Radio).
> Tài liệu này hướng dẫn sử dụng hàng ngày. Muốn tìm hiểu kỹ thuật sâu, xem thêm `README.md` và `CLAUDE.md`.

---

## 1. Phần mềm này làm gì?

FalconHLS Monitor tự động kiểm tra sức khỏe các luồng live HLS (`.m3u8`) theo chu kỳ và báo ngay qua **Telegram** khi luồng gặp sự cố:

- Không lấy được manifest (sai URL, HTTP 4xx/5xx, timeout).
- Luồng đứng hình (media-sequence/segment không đổi).
- Tụt bitrate video/audio, mất track video/audio, tỉ lệ lỗi giải mã cao.
- Gửi tin **phục hồi** khi luồng ổn định trở lại.

Kèm theo **Dashboard web** xem trạng thái thời gian thực, không cần chờ Telegram.

### 1.1. Ba mức trạng thái trên Dashboard

| Màu / nhãn | Ý nghĩa | Cần làm gì? |
|---|---|---|
| 🟢 HOẠT ĐỘNG TỐT | Luồng bình thường (đã xác nhận OK). | Không cần làm gì. |
| 🟡 ĐANG XÁC MINH | Hệ thống vừa phát hiện 1 lần lỗi, đang kiểm tra lại để chắc chắn (chống báo nhầm). Chưa gửi Telegram. | Theo dõi, thường tự hết sau 15–60 giây. |
| 🔴 LỖI | Đã xác nhận sự cố sau nhiều lần kiểm tra liên tiếp, đã gửi Telegram. | Xử lý theo mục 7. |

### 1.2. Tin nhắn Telegram

**Cảnh báo đơn lẻ (1 kênh lỗi):**

```text
🔴 CẢNH BÁO: Luồng [VTVGO] VTV1 HD bị suy giảm!
🏷 Nguyên nhân: Lỗi luồng HLS thực sự
📉 Chi tiết: Bitrate video thực tế (250kbps) < Ngưỡng (400kbps)
🔁 Đã xác nhận sau 3 lần kiểm tra liên tiếp
🕐 Thời điểm: 2026-09-20 10:00:00 (GMT+7)
```

**Cảnh báo diện rộng (nhiều kênh cùng lỗi lúc):** gộp thành 1 tin duy nhất để chống spam.

**Phục hồi:**

```text
🟢 PHỤC HỒI: Luồng [VTVGO] VTV1 HD đã ổn định.
🕐 Thời điểm: 2026-09-20 10:05:00 (GMT+7)
```

> Ghi chú: nếu lỗi do chính máy giám sát quá tải (`Hệ thống giám sát quá tải`), hệ thống **không gửi Telegram**, chỉ ghi log — tránh báo nhầm cho khách hàng.

---

## 2. Yêu cầu trước khi dùng

- **Người dùng cuối (chỉ xem + nhận cảnh báo):** trình duyệt web + Telegram. Không cần cài gì thêm.
- **Người triển khai:** Node.js ≥ 20, `ffmpeg`/`ffprobe` trong `PATH`, hoặc Docker.

---

## 3. Cài đặt và chạy

### 3.1. Chạy thử trên máy cá nhân (Windows)

```bat
npm install
copy .env.example .env
copy config.example.json config.json
npm run dev
```

Mở trình duyệt: `http://localhost:3000/`

Chạy như production:

```bat
npm run build
npm start
```

### 3.2. Lấy Token Telegram (làm 1 lần)

1. Chat với [@BotFather](https://t.me/BotFather), lệnh `/newbot` → nhận `TELEGRAM_BOT_TOKEN`.
2. Thêm bot vào group/channel nhận cảnh báo.
3. Gửi 1 tin bất kỳ vào group, rồi mở trên trình duyệt:
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → tìm `chat.id` (group thường là số âm, VD `-1001234567890`) → điền vào `TELEGRAM_CHAT_ID` trong `.env`.
4. Nếu thiếu 2 biến này, phần mềm vẫn giám sát + ghi log, chỉ không gửi được Telegram.

### 3.3. Chạy trên server (Docker / Coolify)

- Image tự build từ `Dockerfile` (đã gồm ffmpeg + healthcheck `/health` cổng `3000`).
- Bắt buộc mount file `config.json` thật vào `/app/config.json` (file chứa URL luồng nội bộ, không có trong git).
- Khai báo biến môi trường trên Coolify theo mẫu `.env.example` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `VTC_PARTNER_KEYS`...).
- Mỗi lần push lên nhánh `main`, GitHub Actions tự kiểm tra code rồi gọi webhook Coolify redeploy.

---

## 4. Cấu hình kênh giám sát

### 4.1. Hai nguồn kênh

1. **`staticStreams` trong `config.json`** — kênh khai báo tay (dùng khi test hoặc kênh nội bộ). Sửa file local, khởi động lại là nhận.
2. **Partner API (tự động)** — danh sách kênh lấy từ API đối tác mỗi 5 phút, không cần restart khi đối tác thêm/bớt kênh. Khai báo trong `.env`:
   `VTC_PARTNER_KEYS=vtvgo:token1,fpt:token2`

> Tổng số kênh giám sát = static + tất cả Partner. Đổi token URL (đối tác xoay secret) được tự nhận diện, không cần thao tác gì.

### 4.2. Các tham số hay phải chỉnh (`config.json`)

| Tham số | Mặc định | Khi nào chỉnh? |
|---|---|---|
| `checkIntervalSeconds` | 30 | Chu kỳ kiểm tra đầy đủ. Nhiều kênh chung 1 origin → tăng lên (VD 120–180) để tránh bị origin chặn. |
| `fastCheckIntervalSeconds` | 15 | Chu kỳ kiểm tra nhanh (chỉ manifest + đóng băng). Giữ nguyên trừ khi muốn phát hiện đóng băng nhanh/chậm hơn. |
| `cooldownMinutes` | 15 | Chống spam: cùng 1 kênh lỗi liên tục thì sau mỗi 15 phút mới gửi lại 1 tin. Kênh chập chờn gây ồn → tăng lên. |
| `timeoutSeconds` | 10 | Mạng/origin chậm → tăng lên để bớt báo nhầm timeout. |
| `thresholds.minVideoBitrateKbps` | 400 | Kênh HD cần ngưỡng cao hơn, kênh SD/thấp có thể hạ xuống. |
| `thresholds.minAudioBitrateKbps` | 32 | Thường giữ nguyên. |
| `thresholds.maxPacketLossPercentage` | 2 | Nới ra (VD 5) nếu mạng origin không ổn định và báo nhầm nhiều. |
| `retry.*` / `retry.network.*` | 3 lần / 5 lần | Đừng chỉnh nếu chưa hiểu rõ — chính sách NETWORK đã kiên nhẫn hơn STREAM để chờ origin "hạ nhiệt". |

Luồng phát thanh đặt `"type": "radio"` để hệ thống **bỏ qua kiểm tra video** (không báo nhầm "Mất track Video").

### 4.3. Dùng luồng test của Apple (không cần hạ tầng thật)

- TV: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8`
- Radio: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/a2/prog_index.m3u8` (đặt `"type": "radio"`)

---

## 5. Sử dụng Dashboard web

Truy cập `http://localhost:3000/` (local) hoặc domain trên Coolify.

- **Tự động làm mới** mỗi 3 giây (SSE), mất kết nối sẽ tự nối lại.
- **Alert Zone** trên cùng: gom các kênh đang lỗi/cần chú ý.
- **Ô tìm kiếm + bộ lọc:** lọc theo tên kênh, trạng thái (Tất cả / Đang lỗi / Hoạt động tốt), đối tác.
- **Chế độ xem:** Lưới (card) hoặc Danh sách (bảng). Mỗi thẻ hiển thị bitrate Video/Audio đo được và thời điểm kiểm tra gần nhất.
- **Bảo mật:** nếu quản trị viên đã đặt `DASHBOARD_USER`/`DASHBOARD_PASSWORD`, trình duyệt sẽ hỏi đăng nhập (Basic Auth). `/health` luôn mở để Docker kiểm tra sức khỏe container (chỉ trả `{"status":"ok"}`, không chứa dữ liệu kênh).

---

## 6. Vận hành hàng ngày

1. **Buổi sáng:** mở Dashboard, nhìn Alert Zone + số lượng 🟢/🟡/🔴.
2. **Khi có tin Telegram 🔴:** sang mục 7 xử lý.
3. **Khi có tin 🟢:** đóng sự cố, không cần làm gì thêm.
4. **Kiểm tra sức khỏe hệ thống:** mở `/api/status` xem `eventLoopLagMs`, `heapUsedRatio`, hàng đợi ffprobe — lag thường xuyên > 200ms hoặc heap > 90% là máy giám sát đang quá tải, cần giảm số kênh hoặc tăng tài nguyên.
5. **Đọc log:** log vận hành ra console (giờ GMT+7); chi tiết retry/phân loại lỗi nằm trong `diagnostic.log` (đường dẫn theo `DIAGNOSTIC_LOG_PATH`).

---

## 7. Xử lý khi có cảnh báo

| Dòng "Nguyên nhân" trong tin | Ý nghĩa | Cách xử lý |
|---|---|---|
| Lỗi luồng HLS thực sự | Luồng hỏng thật (mất track, tụt bitrate, đóng băng, HTTP 4xx). | Kiểm tra encoder/origin của kênh đó; mở URL `.m3u8` bằng trình phát (VLC) để đối chiếu; xử lý nguồn phát rồi chờ tin phục hồi. |
| Lỗi mạng / mất kết nối Origin-CDN | Không nối được tới origin (timeout, reset, HTTP 5xx) — hay gặp khi nhiều kênh chung 1 origin bị chặn tạm thời. | Thường tự hết sau vài phút (hệ thống đã retry 5 lần, backoff tới 30s). Nếu nhiều kênh cùng origin lỗi 1 lúc (tin gộp diện rộng) → kiểm tra origin/WAF, cân nhắc tăng `checkIntervalSeconds` hoặc giảm `maxConcurrentPerHost`. |
| (Không có tin Telegram) | Hệ thống tự loại vì nghi máy giám sát quá tải. | Kiểm tra `/api/status`: lag/heap cao → giảm tải (tăng interval, giảm kênh, tăng CPU/RAM). Không phải lỗi kênh. |

**Quy tắc chống spam cần nhớ:**

- Lỗi phải lặp lại đủ số lần (STREAM 3 lần, NETWORK 5 lần) mới gửi tin — nên từ lúc luồng hỏng thật tới lúc nhận tin có độ trễ ~15–60 giây là bình thường.
- Cùng 1 kênh đang lỗi liên tục thì mỗi `cooldownMinutes` (mặc định 15 phút) mới gửi nhắc lại 1 lần. Tin phục hồi luôn gửi ngay.

---

## 8. Sự cố thường gặp

| Hiện tượng | Nguyên nhân hay gặp | Cách khắc phục |
|---|---|---|
| Dashboard báo 🟡 mãi rồi tự xanh, không có tin Telegram | Nhiễu mạng nhất thời, hệ thống retry xong và tự phục hồi. | Bình thường, không cần làm gì. Lặp lại nhiều lần trong ngày mới cần điều tra. |
| Chậm nhận tin Telegram 1–2 phút | Cộng dồn thời gian retry xác nhận + gom tin 10 giây. | Bình thường. Muốn nhanh hơn cho lỗi nội dung: giảm `retry.retryDelaysMs`; nhưng sẽ tăng nguy cơ báo nhầm. |
| Nhiều kênh cùng origin báo lỗi 1 lúc rồi cùng phục hồi | Origin/WAF chặn tạm thời do quá nhiều kết nối giám sát dồn dập. | Tăng `checkIntervalSeconds`, giữ `maxConcurrentPerHost: 2`, kiểm tra phía origin có rate-limit IP giám sát không. |
| Kênh radio báo "Mất track Video" | Quên đặt `"type": "radio"`. | Sửa `type` thành `radio` cho kênh đó. |
| Kênh Partner biến mất khỏi Dashboard | Kênh bị đối tác gỡ (`status` khác RUNNING/`live:false`) hoặc API lỗi tạm thời (hệ thống giữ danh sách cũ, sẽ hiện lại ở lần sync sau). | Kiểm tra API đối tác/token `VTC_PARTNER_KEYS`. |
| Container chạy nhưng không giám sát kênh thật | Quên mount `config.json` thật / chưa đặt `VTC_PARTNER_KEYS`, đang chạy config mẫu `example.com`. | Mount `config.json` vào `/app/config.json`, kiểm tra log "Đã nạp cấu hình: N luồng". |
| Dashboard hỏi mật khẩu | Đã bật Basic Auth. | Nhập `DASHBOARD_USER`/`DASHBOARD_PASSWORD` do quản trị viên cấp. |

---

## 9. Lưu ý an toàn

- **Không chia sẻ công khai** `config.json`, `.env`, `diagnostic.log` — chúng chứa URL luồng nội bộ, token API đối tác, token Telegram.
- 2 file `config.json` và `.env` đã nằm trong `.gitignore`, không commit lên git.
- URL luồng của đối tác có gắn token (`?pull=...`): đổi token (xoay secret) không cần sửa gì, hệ thống tự nhận URL mới ở lần sync sau.
- Dashboard/API nên chạy sau HTTPS (Coolify/Traefik) khi mở ra internet; đặt mật khẩu dashboard nếu mở công khai.

---

## 10. Câu hỏi thường gặp

**Hệ thống có ghi lịch sử để xem biểu đồ không?**
Chưa. Hiện chỉ có trạng thái tức thời (Dashboard) + `diagnostic.log` append-only. Muốn biểu đồ lịch sử phải bổ sung database sau.

**Thêm kênh có cần restart không?**
Kênh Partner: không, tự sync mỗi 5 phút. Kênh tay (`staticStreams`): cần khởi động lại.

**Tắt máy/restart có mất gì không?**
Trạng thái trong RAM (đang xác minh, đếm retry) mất; danh sách kênh + config không mất. Tin đang chờ gửi sẽ được flush trước khi thoát.

**Muốn nhận cảnh báo qua email/Slack?**
Chưa hỗ trợ, hiện chỉ Telegram.
