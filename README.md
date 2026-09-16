# StreamGuard HLS

Hệ thống **Giám sát HLS Chủ động** (HLS Active Monitoring Agent) — theo dõi liên tục nhiều luồng live HLS (`.m3u8`) cùng lúc, phát hiện suy giảm chất lượng (đứng hình, tụt bitrate, mất audio, lỗi manifest) và cảnh báo tức thời qua Telegram.

---

## 1. Giới thiệu & Kiến trúc

### 1.1. Tổng quan

StreamGuard HLS là một worker Node.js/TypeScript chạy nền (không cần giao diện), định kỳ kiểm tra sức khỏe của từng luồng HLS theo 3 cấp độ (Level 1 → 3), sau đó so sánh kết quả với ngưỡng cấu hình để quyết định gửi cảnh báo Telegram hay không.

```
┌─────────────────────────────────────────────────────────────────────┐
│                              index.ts                                 │
│  (khởi động config, logger, health server, scheduler)                 │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Scheduler (setInterval) │  1 interval / luồng theo checkIntervalSeconds
                    └────────────┬────────────┘
                                 │ enqueue
                    ┌────────────▼────────────┐
                    │  Worker Queue (p-queue)  │  giới hạn concurrency = maxConcurrentChecks
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      streamChecker       │
                    │  ─────────────────────── │
                    │  Level 1: manifestChecker │  HTTP GET .m3u8, đo latency, parse (RFC 8216),
                    │                            │  tự resolve master playlist -> variant bandwidth cao nhất
                    │                            │  + audio rendition riêng (EXT-X-MEDIA) nếu có
                    │  Level 2: freezeChecker    │  so sánh media-sequence & segment cuối với lần trước
                    │  Level 3: ffprobe/ffmpeg   │  đọc trực tiếp luồng N giây, đo bitrate thực tế
                    │                            │  video/audio, codec, tỉ lệ lỗi giải mã (packet loss)
                    └────────────┬────────────┘
                                 │ so sánh với thresholds
                    ┌────────────▼────────────┐
                    │   telegramBot (Markdown)  │  🔴 cảnh báo suy giảm/mất kết nối · 🟢 phục hồi
                    └───────────────────────────┘
```

### 1.2. Cấu trúc thư mục

```
StreamGuard-HLS/
├── src/
│   ├── config/          # Nạp & validate config.json (zod)
│   ├── ffmpeg/           # Level 3: gọi ffprobe/ffmpeg qua child_process
│   ├── logger/           # Structured logging (Winston)
│   ├── monitor/          # Scheduler, worker queue, Level 1/2, parser m3u8, state
│   ├── telegram/         # Gửi cảnh báo Telegram (Markdown)
│   ├── types/            # Định nghĩa type dùng chung
│   └── index.ts          # Entry point
├── config.example.json    # File cấu hình mẫu, có track trong git (không hardcode trong code)
├── config.json            # File cấu hình thật của bạn — gitignore, KHÔNG commit lên repo
├── .env.example           # Mẫu biến môi trường
├── Dockerfile             # Multi-stage build, cài ffmpeg cho runtime
├── .github/workflows/
│   └── deploy.yml         # CI: typecheck+build -> gọi webhook Coolify khi push nhánh main
└── README.md
```

### 1.3. Tech stack

| Thành phần        | Công nghệ                                   |
| ------------------ | -------------------------------------------- |
| Ngôn ngữ/Runtime    | TypeScript + Node.js 20                      |
| Phân tích AV        | `ffmpeg` / `ffprobe` qua `child_process`     |
| Worker queue        | `p-queue`                                    |
| HTTP client         | `axios`                                      |
| Validate config     | `zod`                                        |
| Logging             | `winston` (JSON structured log ở production) |
| Cảnh báo            | Telegram Bot API (`sendMessage`, Markdown)   |
| Container           | Docker (Alpine + ffmpeg)                     |
| CI/CD               | GitHub Actions → Webhook Coolify             |

### 1.4. Logic 3 cấp độ kiểm tra

1. **Level 1 — Sức khỏe Manifest** (`src/monitor/manifestChecker.ts`)
   HTTP GET `.m3u8`, đo latency, xác nhận HTTP 200 và parse thành công theo RFC 8216. Nếu là **master playlist**, hệ thống tự động chọn variant có bandwidth cao nhất để theo dõi, và nếu variant đó tách audio riêng qua `#EXT-X-MEDIA` (rất phổ biến ở luồng broadcast thật, ví dụ audio 5.1 AC-3 riêng track), hệ thống resolve luôn URL audio rendition tương ứng để kiểm tra chính xác — tránh báo nhầm "mất audio".

2. **Level 2 — Đóng băng luồng Live** (`src/monitor/freezeChecker.ts`)
   So sánh `EXT-X-MEDIA-SEQUENCE` và URI segment cuối cùng giữa 2 lần kiểm tra liên tiếp. Nếu cả hai không đổi trên một luồng đang live (không có `#EXT-X-ENDLIST`) → nghi ngờ luồng bị treo (encoder đứng, CDN cache lỗi...).

3. **Level 3 — Chất lượng AV sâu** (`src/ffmpeg/ffprobe.ts`)
   Dùng `ffprobe` xác định codec/track video, audio; dùng `ffmpeg -t <N> -f null -` để decode thực tế luồng trong vài giây, đọc bitrate đạt được (`bitrate=... kbits/s`) và đếm các cảnh báo continuity/corrupt-frame trong stderr để ước lượng tỉ lệ lỗi giải mã (packet loss heuristic). So sánh với `thresholds` trong config để phát hiện tụt bitrate hoặc mất track.

---

## 2. Ý nghĩa các tham số cấu hình (`config.json`)

| Tham số                            | Kiểu      | Ý nghĩa                                                                                          |
| ----------------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `streams[].name`                    | string    | Tên định danh luồng, hiển thị trong log & tin nhắn Telegram.                                        |
| `streams[].url`                     | string    | URL `.m3u8` (media hoặc master playlist) cần giám sát.                                              |
| `streams[].type`                    | `"tv"` \| `"radio"` | Loại luồng. `"tv"` (mặc định nếu bỏ trống): bắt buộc có cả Video+Audio, thiếu Video sẽ bị cảnh báo. `"radio"`: chỉ kiểm tra Audio, **bỏ qua hoàn toàn** kiểm tra Video (không decode/đo bitrate video, tiết kiệm CPU và không báo nhầm "Mất track Video"). |
| `checkIntervalSeconds`              | number    | Tần suất kiểm tra mỗi luồng (giây). Ví dụ `30` = kiểm tra mỗi 30 giây.                               |
| `cooldownMinutes`                   | number    | Thời gian chờ tối thiểu giữa 2 lần gửi cảnh báo **lỗi** liên tiếp cho cùng một luồng (chống spam). Cảnh báo phục hồi (🟢) luôn được gửi ngay, không bị cooldown. |
| `timeoutSeconds`                    | number    | Timeout tối đa cho mỗi request HTTP (Level 1) và mỗi lệnh `ffprobe`/`ffmpeg` (Level 3).              |
| `ffprobeDurationSeconds`            | number    | Số giây đọc thực tế luồng qua `ffmpeg` để đo bitrate/lỗi giải mã ở Level 3. Giá trị lớn hơn cho kết quả chính xác hơn nhưng tốn tài nguyên hơn. |
| `maxConcurrentChecks`               | number    | Số lượng kiểm tra (đặc biệt là Level 3, tốn CPU) được chạy song song tối đa — giới hạn worker queue để tránh nghẽn khi có nhiều luồng. |
| `thresholds.minVideoBitrateKbps`    | number    | Ngưỡng bitrate video tối thiểu (kbps). Thấp hơn → cảnh báo tụt chất lượng.                           |
| `thresholds.minAudioBitrateKbps`    | number    | Ngưỡng bitrate audio tối thiểu (kbps).                                                              |
| `thresholds.maxPacketLossPercentage`| number    | Tỉ lệ phần trăm lỗi giải mã (continuity/corrupt frame) tối đa cho phép trước khi cảnh báo.           |
| `thresholds.maxManifestLatencyMs`   | number    | Độ trễ tối đa (ms) khi tải manifest trước khi bị coi là suy giảm (CDN/mạng chậm).                    |

> File cấu hình được đọc từ đường dẫn trong biến môi trường `CONFIG_PATH` (mặc định `./config.json`) và được validate nghiêm ngặt bằng `zod` khi khởi động — nếu thiếu/sai kiểu, ứng dụng sẽ báo lỗi rõ ràng và dừng ngay thay vì chạy với giá trị ngầm định sai.
>
> `config.json` nằm trong `.gitignore` (giống `.env`) vì thường chứa URL luồng nội bộ/thật của bạn — **không commit lên git**. Repo chỉ track `config.example.json` làm mẫu; xem bước tạo `config.json` từ mẫu này ở mục 3.2 bên dưới.

---

## 3. Chạy thử ở môi trường Local (Dev)

### 3.1. Yêu cầu

- Node.js ≥ 20
- `ffmpeg` + `ffprobe` đã cài và có trong `PATH` ([tải tại đây](https://ffmpeg.org/download.html), hoặc `winget install ffmpeg` / `apt install ffmpeg` / `brew install ffmpeg`)

### 3.2. Các bước

```bash
# 1. Cài dependencies
npm install

# 2. Tạo file .env từ mẫu và điền TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
cp .env.example .env

# 3. Tạo config.json từ mẫu rồi khai báo danh sách luồng thực tế cần giám sát
#    (streams[].url phải là URL .m3u8 thật, streams[].type là "tv" hoặc "radio")
cp config.example.json config.json

# 4. Chạy ở chế độ dev (hot-reload qua ts-node-dev)
npm run dev

# Hoặc build & chạy như production:
npm run build
npm start
```

Sau khi chạy, truy cập `http://localhost:3000/health` để xem nhanh trạng thái tất cả các luồng đang giám sát (dùng cho debug hoặc làm health check endpoint cho Coolify).

### 3.3. Lấy `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID`

1. Chat với [@BotFather](https://t.me/BotFather) trên Telegram, dùng lệnh `/newbot` để tạo bot mới → nhận `TELEGRAM_BOT_TOKEN`.
2. Thêm bot vào group/channel muốn nhận cảnh báo (hoặc chat trực tiếp với bot).
3. Lấy `chat_id`: gửi một tin nhắn bất kỳ vào group/chat đó, sau đó gọi:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Tìm trường `chat.id` trong JSON trả về (group/channel thường có id âm, ví dụ `-1001234567890`).

---

## 4. Triển khai CI/CD: GitHub → Coolify

### 4.1. Chuẩn bị trên Coolify

1. Tạo một **Application** mới trên Coolify, chọn nguồn **Docker** (build từ `Dockerfile` trong repo).
2. Coolify sẽ tự nhận diện `Dockerfile` và `HEALTHCHECK` (endpoint `/health`, cổng `3000`) để theo dõi tình trạng container.
3. Khai báo **Environment Variables** trên Coolify (tab *Environment Variables* của Application) theo mẫu `.env.example`:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `PORT=3000` (hoặc để Coolify tự map)
   - `LOG_LEVEL=info`
4. Nếu muốn thay đổi danh sách luồng/ngưỡng cảnh báo mà không rebuild image, mount `config.json` dưới dạng **Volume/File mount** vào `/app/config.json` trong phần *Storage* của Coolify.
5. Vào **Webhooks** của Application trên Coolify (mục *Webhooks* / *Deploy Webhook*), copy URL webhook — đây chính là giá trị cần đưa vào GitHub Secret `COOLIFY_WEBHOOK_URL`. Nếu Coolify yêu cầu token xác thực riêng, lưu token đó vào secret `COOLIFY_WEBHOOK_TOKEN` (workflow sẽ tự thêm header `Authorization: Bearer` nếu secret này tồn tại).

### 4.2. Cấu hình GitHub Secrets

Vào repo trên GitHub → **Settings → Secrets and variables → Actions → New repository secret**, thêm:

| Secret name              | Bắt buộc | Mô tả                                             |
| -------------------------- | -------- | ---------------------------------------------------- |
| `COOLIFY_WEBHOOK_URL`      | Có       | URL webhook deploy lấy từ Coolify (bước 4.1.5).       |
| `COOLIFY_WEBHOOK_TOKEN`    | Không    | Token xác thực webhook, nếu Coolify instance yêu cầu. |

### 4.3. Luồng hoạt động của `deploy.yml`

Mỗi khi có `push` vào nhánh `main`:

1. Job **build-and-typecheck**: cài dependency, chạy `npm run typecheck` và `npm run build` để đảm bảo code không lỗi trước khi deploy.
2. Job **deploy** (chỉ chạy nếu job trên thành công): gọi `POST` tới `COOLIFY_WEBHOOK_URL` để yêu cầu Coolify pull code mới nhất và rebuild/redeploy container.

> Coolify tự build lại image từ `Dockerfile` trong repo khi nhận webhook — không cần GitHub Actions build & push image lên registry.

---

## 5. Định dạng cảnh báo Telegram

**Khi phát hiện suy giảm:**
```
🔴 CẢNH BÁO: Luồng Demo-Channel-1 bị suy giảm!
📉 Chi tiết: Bitrate video thực tế (200kbps) < Ngưỡng (400kbps)
🕐 Thời điểm: 2026-09-17T10:00:00.000Z
```

**Khi mất kết nối manifest:**
```
🔴 CẢNH BÁO: Luồng Demo-Channel-1 mất kết nối!
📉 Chi tiết: HTTP 404 khi lấy manifest
🕐 Thời điểm: 2026-09-17T10:00:00.000Z
```

**Khi phục hồi:**
```
🟢 PHỤC HỒI: Luồng Demo-Channel-1 đã ổn định.
🕐 Thời điểm: 2026-09-17T10:05:00.000Z
```

---

## 6. Lưu ý vận hành

- Nếu thiếu `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, hệ thống vẫn tiếp tục giám sát và ghi log đầy đủ, chỉ riêng bước gửi Telegram sẽ bị bỏ qua (log lỗi, không crash).
- Mọi lỗi từ `ffmpeg`/`ffprobe` (treo tiến trình, mạng chập chờn) đều có timeout cứng (`timeoutSeconds`) và được bắt tại từng lớp (`streamChecker`, `scheduler`), không làm sập toàn bộ tiến trình Node.js.
- Tỉ lệ lỗi giải mã (`packetLossPercentage`) là **giá trị ước lượng** (heuristic) dựa trên số dòng cảnh báo continuity/corrupt-frame mà `ffmpeg` in ra trong thời gian lấy mẫu (`ffprobeDurationSeconds`), không phải số đo packet loss ở tầng mạng (RTP/UDP). Phù hợp cho mục đích giám sát tương đối, không thay thế công cụ đo network chuyên dụng.
- Bitrate thực tế (Level 3) được đo bằng cách remux (không re-encode) nội dung ra `mpegts` trong bộ nhớ và tính `bytes*8 / thời-lượng-nội-dung` (ưu tiên lấy trực tiếp từ `bitrate=` do `ffmpeg` tự báo cáo) — **không** dùng thời gian tải mạng thực tế (wall-clock) làm mẫu số, vì CDN có thể trả dữ liệu nhanh hơn nhiều lần tốc độ phát thực (`speed=10-20x` khi cache tốt), dẫn đến số liệu sai lệch nếu tính theo wall-clock.
- Với luồng `"radio"`: hệ thống không decode/đo track Video dù luồng gốc có lẫn track video (ví dụ ảnh bìa/ID3 image) — chỉ Audio được kiểm tra so với `thresholds`.
