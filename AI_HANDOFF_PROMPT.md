# Prompt bàn giao dự án: StreamGuard HLS

> Dán toàn bộ nội dung file này vào đầu phiên làm việc với bất kỳ AI coding assistant nào (Claude, ChatGPT, Gemini, Copilot Chat...) khi tiếp tục phát triển dự án `FalconHLS-Monitor`. File này thay thế cho việc phải giải thích lại từ đầu.

## Vai trò của bạn

Bạn là kỹ sư phần mềm cấp cao, tiếp quản một dự án TypeScript/Node.js đã hoàn thiện phần lõi và đang chạy thực tế. Nhiệm vụ của bạn là đọc kỹ ngữ cảnh dưới đây, sau đó thực hiện yêu cầu tiếp theo mà người dùng đưa ra (thêm tính năng / sửa lỗi / refactor...). KHÔNG viết lại từ đầu — dự án đã có kiến trúc rõ ràng, hãy làm việc trong khuôn khổ đó.

## Dự án là gì

**StreamGuard HLS**: hệ thống giám sát chủ động (active monitoring) nhiều luồng phát trực tiếp HLS (`.m3u8`) cùng lúc — cả luồng truyền hình (TV, có Video+Audio) và phát thanh (Radio, chỉ Audio). Hệ thống định kỳ kiểm tra sức khỏe từng luồng qua 3 cấp độ, phát hiện suy giảm chất lượng (đứng hình, tụt bitrate, mất track, lỗi manifest), và gửi cảnh báo tức thời qua Telegram Bot. Chạy dạng worker nền (không UI), triển khai bằng Docker trên Coolify, CI/CD qua GitHub Actions.

Repo: `https://github.com/canona/FalconHLS-Monitor` (public, nhánh `main`).

## Yêu cầu gốc (đã hoàn thành 100%)

1. Ngôn ngữ/Runtime: TypeScript + Node.js.
2. Phân tích video bằng `ffmpeg`/`ffprobe` qua `child_process` (không dùng `fluent-ffmpeg`).
3. Kiến trúc: Scheduler + Worker Queue (`p-queue`) để check nhiều luồng song song không nghẽn.
4. Cấu hình 100% qua `config.json` (không hardcode) — validate bằng `zod`: danh sách streams (`name`, `url`, `type: "tv"|"radio"`), `checkIntervalSeconds`, `cooldownMinutes`, `thresholds` (bitrate/packet-loss/latency), `timeoutSeconds`.
5. Logic giám sát 3 cấp độ:
   - **Level 1** (Manifest): HTTP GET `.m3u8`, đo latency, parse RFC 8216, tự resolve master playlist → variant bandwidth cao nhất + audio rendition riêng (`#EXT-X-MEDIA`) nếu master tách audio.
   - **Level 2** (Freeze detection): so sánh `EXT-X-MEDIA-SEQUENCE` + segment cuối giữa 2 lần check liên tiếp.
   - **Level 3** (AV sâu qua ffprobe/ffmpeg): đo bitrate thật, codec, track có/thiếu, tỉ lệ lỗi giải mã (packet-loss heuristic).
6. Cảnh báo Telegram (Markdown), đọc token/chat-id từ `.env`, chống spam bằng `cooldownMinutes`, tin nhắn 🔴 suy giảm / 🔴 mất kết nối / 🟢 phục hồi.
7. Docker production (Node + ffmpeg cài qua Alpine), `.env.example`, GitHub Actions gọi Coolify webhook khi push `main`.
8. README chi tiết (kiến trúc, ý nghĩa từng tham số config, hướng dẫn chạy local, hướng dẫn setup CI/CD).
9. Code sạch, chia module theo SOLID, structured logging (Winston), bắt lỗi triệt để (ffmpeg treo/mạng lỗi không được làm crash toàn tiến trình).

## Yêu cầu bổ sung đã làm sau đó

- Hỗ trợ 2 loại luồng `type: "tv" | "radio"` (mặc định `"tv"`) — luồng radio bỏ qua hoàn toàn kiểm tra/decode Video.
- Giờ hiển thị trong log và tin nhắn Telegram cố định theo **GMT+7 (Asia/Ho_Chi_Minh)**, không phụ thuộc timezone của host/container.
- `config.json` (chứa URL luồng thật) bị gitignore; `config.example.json` là file mẫu track trong git — vì repo là **public**.

## Kiến trúc & vị trí code (đọc trực tiếp trong repo, đừng đoán)

```
src/config/config.ts        Load + validate config.json (zod)
src/types/index.ts          Type definitions dùng chung
src/utils/time.ts           formatVnTime() — giờ GMT+7 cố định
src/logger/logger.ts        Winston logger
src/monitor/m3u8Parser.ts   Parser HLS tự viết (không dùng lib ngoài)
src/monitor/manifestChecker.ts   Level 1
src/monitor/freezeChecker.ts     Level 2
src/monitor/streamChecker.ts     Orchestrator Level 1->2->3 + quyết định alert
src/monitor/stateStore.ts        In-memory state per-stream
src/monitor/scheduler.ts         setInterval + p-queue
src/monitor/healthServer.ts      HTTP GET /health
src/ffmpeg/ffprobe.ts       Level 3 — ĐỌC KỸ mục "bẫy kỹ thuật" bên dưới trước khi sửa file này
src/telegram/telegramBot.ts Build message + gửi Telegram — ĐỌC KỸ mục MarkdownV2 bên dưới
src/index.ts                 Entry point
```

File `CLAUDE.md` ở root repo có ghi chú kỹ thuật chi tiết hơn — nếu AI của bạn hỗ trợ đọc file đó tự động (Claude Code), nó sẽ tự nạp. Nếu không, hãy đọc file đó thủ công trước khi sửa code.

## Bẫy kỹ thuật QUAN TRỌNG (đã tốn nhiều thời gian debug — đừng lặp lại)

Đây là các bug thật đã xảy ra và đã fix, không phải giả định lý thuyết:

1. **`ffmpeg -f null -` không bao giờ cho bitrate thật** (`bitrate=N/A` luôn luôn, vì muxer null không biết size output) → từng khiến kiểm tra ngưỡng bitrate không hoạt động mà KHÔNG có lỗi/crash nào — chỉ âm thầm sai. Fix: 1 lệnh ffmpeg với 2 output song song (`-c copy -f mpegts pipe:1` để lấy bitrate thật + `-f null -` để bắt lỗi giải mã).
2. **`-t <duration>` phải lặp lại cho từng output** khi ffmpeg có nhiều output trong 1 lệnh — nếu không, output không có `-t` sẽ chạy vô thời hạn, treo tiến trình.
3. **Bitrate phải tính theo thời lượng NỘI DUNG (content-time/PTS)**, không phải wall-clock — CDN cache trả dữ liệu nhanh hơn tốc độ phát thực (`speed=10-20x`) khiến tính theo wall-clock cho ra số bị thổi phồng sai hoàn toàn.
4. **`ffmpeg` không in `frame=` khi decode audio-only** — cần fallback đếm `time=` làm mẫu số cho packet-loss.
5. **Luôn spawn ffmpeg với `-nostdin`** — tránh treo vô thời hạn khi chờ input tương tác trong môi trường non-TTY.
6. **`parse_mode: "MarkdownV2"` của Telegram yêu cầu escape ký tự đặc biệt trong CẢ text tĩnh, không chỉ biến nội suy** — quên escape `!`/`.` từng gây lỗi 400 khiến TOÀN BỘ alert không gửi được (lỗi bị catch và chỉ log, không crash — dễ bị bỏ sót nếu không đọc log kỹ).
7. **Giờ phải dùng `formatVnTime()` (Intl `timeZone: "Asia/Ho_Chi_Minh"`)**, không dùng `.toISOString()` — container Docker mặc định UTC.
8. **Master playlist tách audio riêng qua `#EXT-X-MEDIA`** (attribute `TYPE=AUDIO` là enumerated-string KHÔNG có dấu ngoặc kép, khác với `GROUP-ID="..."`/`URI="..."` là quoted-string CÓ ngoặc kép — dễ viết regex sai nếu không phân biệt) là tình huống rất phổ biến ở luồng broadcast thật (VD track AC-3 5.1 riêng). Bỏ qua bước resolve này sẽ báo nhầm "Mất track Audio".
9. Regex bắt `BANDWIDTH=` trong `#EXT-X-STREAM-INF` phải tránh khớp nhầm với `AVERAGE-BANDWIDTH=` (dùng anchor `(?:^|,)BANDWIDTH=`).

## Cách test (không cần hạ tầng streaming thật)

Luồng test công khai của Apple, đã verify hoạt động ổn định:
- TV (master playlist, có variant tách audio riêng AC-3 5.1): `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8`
- Radio/audio-only thật (dùng test `type: "radio"`): `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/a2/prog_index.m3u8`

Lệnh: `npm install && npm run typecheck && npm run build`, rồi `npm run dev` với `config.json` local (không track git) trỏ 2 URL trên.

## Việc chưa làm / có thể được yêu cầu tiếp theo

- Dashboard/UI xem trạng thái realtime (hiện chỉ có `GET /health` trả JSON thô).
- Lưu lịch sử kiểm tra vào database (hiện tại state 100% in-memory, mất khi restart).
- Kênh cảnh báo khác ngoài Telegram (email, Slack, webhook tổng quát).
- `thresholds` theo từng stream riêng thay vì global chung cho tất cả.
- Test tự động (unit/integration test) — hiện chưa có test suite, mới chỉ verify bằng chạy tay + script debug thủ công.

---

**Việc cần làm tiếp theo do người dùng chỉ định (điền vào đây khi bàn giao):**

_(để trống — người dùng sẽ mô tả yêu cầu cụ thể ngay sau khi dán prompt này)_
