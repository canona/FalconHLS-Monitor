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
│   ├── logger/           # Structured logging (Winston) + diagnostic.log riêng
│   ├── monitor/          # Scheduler, worker queue, Level 1/2/3, incident state machine
│   ├── telegram/         # Build message + gửi Telegram (MarkdownV2), gộp cảnh báo (AlertManager)
│   ├── web/              # Express server: dashboard tĩnh + /api/status + /api/events (SSE)
│   ├── types/            # Định nghĩa type dùng chung
│   └── index.ts          # Entry point
├── public/
│   └── index.html         # Dashboard tĩnh (Tailwind CDN + vanilla JS, không build step)
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
| Logging             | `winston` (JSON structured log ở production, + file riêng `diagnostic.log`) |
| Web Dashboard       | `express` (API + static) + Server-Sent Events, frontend HTML/Tailwind CDN/vanilla JS |
| Cảnh báo            | Telegram Bot API (`sendMessage`, MarkdownV2), gộp qua AlertManager |
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
| `maxConcurrentChecks`               | number    | Số tiến trình **ffprobe/ffmpeg (Level 3)** chạy đồng thời tối đa trên toàn hệ thống. Đây là nút thắt tài nguyên thật (CPU decode + network) — luồng khác phải xếp hàng chờ trong queue riêng (không liên quan tới queue Level 1/2). |
| `maxConcurrentManifestChecks`       | number    | *(mới, mặc định `10`)* Số luồng được kiểm tra Level 1/2 (HTTP, nhẹ) đồng thời tối đa — tách riêng khỏi `maxConcurrentChecks` vì HTTP GET manifest rẻ hơn nhiều so với chạy ffprobe. |
| `maxConcurrentPerHost`              | number    | *(mới, mặc định `2`)* Số tiến trình Level 3 chạy đồng thời tối đa tới **CÙNG một hostname**, độc lập với `maxConcurrentChecks` (giới hạn tổng). Quan trọng khi nhiều kênh dùng chung 1 origin (VD nhiều đài cùng phát qua 1 hạ tầng catchup/CDN) — nếu không giới hạn riêng theo host, origin (hoặc lớp WAF/anti-leech phía trước) có thể coi nhiều kết nối TCP dồn dập từ cùng 1 IP giám sát là traffic bất thường và tạm thời rate-limit/timeout kết nối, gây báo động sai dù người xem thật không gặp vấn đề gì. |
| `thresholds.minVideoBitrateKbps`    | number    | Ngưỡng bitrate video tối thiểu (kbps). Thấp hơn → cảnh báo tụt chất lượng.                           |
| `thresholds.minAudioBitrateKbps`    | number    | Ngưỡng bitrate audio tối thiểu (kbps).                                                              |
| `thresholds.maxPacketLossPercentage`| number    | Tỉ lệ phần trăm lỗi giải mã (continuity/corrupt frame) tối đa cho phép trước khi cảnh báo.           |
| `thresholds.maxManifestLatencyMs`   | number    | Độ trễ tối đa (ms) khi tải manifest trước khi bị coi là suy giảm (CDN/mạng chậm).                    |
| `retry.maxRetries`                  | number    | *(mới, mặc định `3`)* Chính sách retry cho category **`STREAM`** (lỗi nội dung thật: mất track, tụt bitrate, đóng băng...). Tổng số lần kiểm tra liên tiếp thất bại (kể cả lần đầu) trước khi XÁC NHẬN sự cố và chuẩn bị gửi cảnh báo. Trước khi đủ số lần này, luồng ở trạng thái nội bộ `SUSPECT` — chưa gửi Telegram, chỉ retry và ghi diagnostic log. |
| `retry.retryDelaysMs`               | number[]  | *(mới, mặc định `[5000, 10000]`)* Độ trễ (ms) trước mỗi lần retry của category `STREAM`, độ dài = `maxRetries - 1`. VD với `maxRetries: 3`: thất bại lần 1 → đợi 5s → thử lại (lần 2) → nếu vẫn lỗi đợi 10s → thử lại (lần 3) → nếu vẫn lỗi mới xác nhận. |
| `retry.network.maxRetries`          | number    | *(mới, mặc định `5`)* Chính sách retry RIÊNG cho category **`NETWORK`** (timeout/refused khi kết nối origin — thường do origin/WAF rate-limit khi giám sát nhiều kênh chung 1 origin). Kiên nhẫn hơn hẳn `STREAM` để origin có đủ thời gian "hạ nhiệt" trước khi hệ thống kết luận luồng đã chết và gửi Telegram. |
| `retry.network.retryDelaysMs`       | number[]  | *(mới, mặc định `[15000, 30000, 30000, 30000]`)* Độ trễ (ms) trước mỗi lần retry của category `NETWORK` — dài hơn hẳn `STREAM` (15s rồi 30s thay vì 5s/10s). |
| `alertBatching.windowMs`            | number    | *(mới, mặc định `10000` = 10 giây)* Khung thời gian (ms) AlertManager gom các sự cố ĐÃ XÁC NHẬN lại trước khi quyết định gửi. Nếu hết hạn mà chỉ có 1 sự cố trong buffer, gửi ngay dưới dạng tin đơn lẻ (không đợi thêm) — giá trị này chỉ ảnh hưởng tới việc "có kênh khác lỗi cùng lúc để gộp digest hay không", không làm chậm kênh lỗi đơn lẻ quá lâu. |
| `alertBatching.minCountToDigest`    | number    | *(mới, mặc định `3`)* Nếu số sự cố xác nhận trong 1 khung `windowMs` **lớn hơn** giá trị này, gộp thành 1 tin nhắn "CẢNH BÁO DIỆN RỘNG" duy nhất thay vì gửi riêng từng tin. |
| `diagnostics.eventLoopLagThresholdMs` | number  | *(mới, mặc định `200`)* Event-loop lag (ms) vượt ngưỡng này tại thời điểm 1 lần check thất bại → phân loại nguyên nhân là `SYSTEM_OVERLOAD` (không gửi Telegram, chỉ log). |
| `diagnostics.memoryHeapUsedRatioThreshold` | number | *(mới, mặc định `0.9`)* Tỉ lệ `used_heap_size / heap_size_limit` (giới hạn heap thật của V8, **không** phải `heapUsed/heapTotal` — chỉ số đó nhiễu và gây false positive) vượt ngưỡng này → cũng tính là `SYSTEM_OVERLOAD`. |
| `diagnostics.ffprobeSlowThresholdMs`  | number  | *(mới, mặc định `8000`)* ffprobe/ffmpeg chạy lâu hơn ngưỡng này dù vẫn THÀNH CÔNG → ghi cảnh báo "nghẽn" (bottleneck) vào `diagnostic.log`, không tính là lỗi. |

> **Về việc đặt tên tham số:** để nhất quán với cấu trúc lồng nhau sẵn có (`thresholds.*`), các tham số mới được nhóm theo chức năng thay vì để phẳng: `maxRetries` bạn đề xuất → `retry.maxRetries`; `batchWindowMs` → `alertBatching.windowMs`. `maxConcurrentChecks` giữ nguyên tên nhưng đổi ý nghĩa (nay áp riêng cho Level 3/ffprobe) theo đúng yêu cầu.
>
> Tất cả tham số mới đều có giá trị mặc định (qua `zod .default()`) — `config.json` cũ (không có các trường này) vẫn chạy được ngay, không cần sửa gì nếu bạn chỉ muốn dùng giá trị mặc định.

> File cấu hình được đọc từ đường dẫn trong biến môi trường `CONFIG_PATH` (mặc định `./config.json`) và được validate nghiêm ngặt bằng `zod` khi khởi động — nếu thiếu/sai kiểu, ứng dụng sẽ báo lỗi rõ ràng và dừng ngay thay vì chạy với giá trị ngầm định sai.
>
> `config.json` nằm trong `.gitignore` (giống `.env`) vì thường chứa URL luồng nội bộ/thật của bạn — **không commit lên git**. Repo chỉ track `config.example.json` làm mẫu; xem bước tạo `config.json` từ mẫu này ở mục 3.2 bên dưới.

### 2.1. Kiến trúc "Deep Diagnostic" (chống false-positive khi giám sát nhiều luồng)

Khi số luồng tăng lên (VD 25-30+), nguy cơ lớn nhất không phải là luồng thật sự hỏng mà là **hệ thống giám sát tự gây nhiễu** (ffprobe timeout do quá tải CPU, mạng chập chờn tức thời...). Cơ chế dưới đây giải quyết trực tiếp vấn đề đó:

1. **Phân loại nguyên nhân gốc rễ** (`src/monitor/errorClassifier.ts`) — mỗi lần kiểm tra thất bại được gắn 1 trong 3 nhãn:
   - `SYSTEM_OVERLOAD`: event-loop lag hoặc áp lực bộ nhớ vượt ngưỡng tại thời điểm check, HOẶC **CHÍNH TA** chủ động SIGKILL tiến trình ffprobe/ffmpeg vì nó không phản hồi kịp `timeoutSeconds` (`WorkerTimeoutError`). **Không gửi Telegram** — chỉ ghi log cấp `warn` + `diagnostic.log`, vì đây nhiều khả năng là lỗi của chính worker giám sát chứ không phải luồng.
   - `NETWORK`: DNS fail, `ECONNRESET`, HTTP 5xx, mất kết nối Origin/CDN — bao gồm cả lỗi kết nối gốc mà chính ffmpeg/ffprobe tự báo (VD `Operation timed out`, `Connection to tcp://...`) khi origin từ chối/rate-limit kết nối, KHÁC với `SYSTEM_OVERLOAD` ở trên (đây là ffmpeg tự thoát, không phải ta ép dừng).
   - `STREAM`: parse manifest lỗi, HTTP 4xx, mất track, tụt bitrate, đóng băng — lỗi luồng HLS thực sự.
   - Cả `NETWORK` và `STREAM` đều hiển thị nhãn này trong tin nhắn Telegram (dòng "🏷 Nguyên nhân").

2. **Debounce bằng state machine SUSPECT → retry → xác nhận, với chính sách RIÊNG theo category** (`src/monitor/incidentManager.ts`) — không có luồng nào bị báo lỗi ngay ở lần phát hiện đầu tiên. Khi 1 lần check thất bại, luồng vào trạng thái nội bộ `SUSPECT`, hệ thống tự lên lịch kiểm tra lại theo chính sách của ĐÚNG category đó: `STREAM` dùng `retry.maxRetries`/`retry.retryDelaysMs` (mặc định 3 lần, 5s/10s — lỗi nội dung thật nên xác nhận nhanh); `NETWORK` dùng `retry.network.maxRetries`/`retry.network.retryDelaysMs` (mặc định 5 lần, 15s/30s/30s/30s — kiên nhẫn hơn để origin/WAF có thời gian "hạ nhiệt" trước khi kết luận luồng đã chết). Chỉ khi thất bại đủ số lần LIÊN TIẾP theo policy tương ứng mới xác nhận sự cố thật và chuyển sang AlertManager. Trong lúc `SUSPECT`, lịch kiểm tra định kỳ bình thường của luồng đó tạm dừng (tránh vừa retry vừa bị interval cũ bắn thêm 1 lần chồng lấn).

3. **Chống chồng lấn kiểm tra** (`isChecking` flag trong `stateStore.ts`) — nếu 1 luồng vẫn đang được kiểm tra (đang trong queue hoặc đang chạy ffprobe) mà tới hạn interval tiếp theo, lần kiểm tra mới bị bỏ qua thay vì xếp chồng, tránh hàng đợi phình to vô hạn khi có nhiều luồng và tài nguyên hạn chế.

4. **2 lớp queue ffprobe: tổng + theo host** (`src/ffmpeg/ffprobe.ts`) — tách hoàn toàn khỏi queue Level 1/2. Mỗi lần gọi `analyzeStream()` phải xin "vé" ở CẢ 2 hàng đợi lồng nhau: hàng đợi theo **hostname** (`configureHostConcurrency`, giới hạn `maxConcurrentPerHost` — chặn đúng nguyên nhân origin bị rate-limit khi nhiều kênh chung 1 origin) rồi mới tới hàng đợi **tổng** (`configureFfprobeConcurrency`, giới hạn `maxConcurrentChecks`). Mỗi lần chạy còn được đo `executionMs`; nếu vượt `diagnostics.ffprobeSlowThresholdMs` dù vẫn thành công, hệ thống tự ghi cảnh báo "nghẽn" vào `diagnostic.log` để bạn trace được bottleneck. Ngoài ra, mỗi track (video/audio) chỉ cần ĐÚNG 1 tiến trình ffmpeg duy nhất (không còn bước `probeMetadata` riêng bằng ffprobe) — giảm một nửa số kết nối TCP ra origin cho mỗi lần kiểm tra Level 3.

5. **AlertManager gộp tin nhắn** (`src/telegram/alertManager.ts`) — các sự cố ĐÃ XÁC NHẬN (qua bước 2) được gom trong `alertBatching.windowMs`; nếu số lượng vượt `alertBatching.minCountToDigest` trong cùng khung, gộp thành 1 tin nhắn "🔴 CẢNH BÁO DIỆN RỘNG (Gộp)" duy nhất thay vì bắn từng tin riêng lẻ — đúng kịch bản sự cố mạng tổng làm nhiều luồng cùng lúc gặp vấn đề.

6. **Diagnostic log riêng** (`diagnostic.log`, cấu hình đường dẫn qua biến môi trường `DIAGNOSTIC_LOG_PATH`) — ghi lại toàn bộ: kết quả phân loại lỗi, thời điểm/số lần retry, thời gian thực thi ffprobe, lý do skip check, việc gộp tin nhắn... dạng JSON, tách khỏi log vận hành chính (console) để không bị loãng khi cần trace nguyên nhân của 1 cảnh báo cụ thể.

Xem thêm trạng thái debug qua `GET /health` — nay trả về cả `phase` (`STABLE`/`SUSPECT`), `suspectAttempt`, và tình trạng tài nguyên hệ thống (`eventLoopLagMs`, `heapUsedRatio`, `ffprobeQueue`).

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
4. **Bắt buộc** mount `config.json` thật dưới dạng **Volume/File mount** vào `/app/config.json` trong phần *Storage* của Coolify. `config.json` chứa URL luồng nội bộ nên bị gitignore (không có trong repo) — image chỉ đóng gói sẵn `config.example.json` (đổi tên thành `config.json`) làm placeholder để container khởi động được, **không trỏ tới luồng thật nào**. Nếu bỏ qua bước này, container vẫn chạy "khỏe" (health check pass) nhưng chỉ giám sát URL mẫu `example.com` vô nghĩa.
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

## 5. Web Dashboard (Real-time)

### 5.1. Tổng quan

Ứng dụng phục vụ luôn một Dashboard web (dark mode) chạy **chung 1 cổng** với API/health check (`PORT`, mặc định `3000`) — không cần mở thêm port riêng. Truy cập `http://localhost:3000/` (local) hoặc domain đã trỏ trên Coolify (VD `https://falconhlsmonitor.vtcdigital.top/`) để xem trạng thái toàn bộ luồng theo thời gian thực, không cần chờ Telegram.

- **Backend:** Express (`src/web/server.ts`), phục vụ file tĩnh trong `public/` + 3 route:
  - `GET /` — trang dashboard (`public/index.html`).
  - `GET /api/status` — JSON trạng thái toàn bộ luồng tại thời điểm gọi (dùng cho polling/tích hợp hệ thống khác).
  - `GET /api/events` — **Server-Sent Events**: đẩy lại toàn bộ trạng thái mỗi 3 giây, dashboard tự cập nhật không cần tải lại trang. Nếu trình duyệt/proxy không hỗ trợ SSE, JS tự động chuyển sang polling `/api/status` mỗi 5 giây (fallback, xem `public/index.html`).
  - `GET /health` — giữ nguyên cho Docker `HEALTHCHECK`, nay trả kèm luôn dữ liệu dashboard.
- **Frontend:** 1 file tĩnh `public/index.html` (HTML + Tailwind CDN + vanilla JS, không build step, không framework) — do Dockerfile `COPY public ./public` trực tiếp vào image, không qua `tsc`.

### 5.2. Dữ liệu mỗi luồng (`/api/status`)

```json
{
  "name": "VOV1", "url": "...", "type": "radio",
  "status": "HEALTHY",       // HEALTHY | SUSPECT | DEGRADED — rút gọn cho dashboard
  "rawStatus": "OK",         // OK | DEGRADED | DOWN — trạng thái chi tiết gốc
  "lastError": null,          // issue đầu tiên của lần check gần nhất, null nếu không có
  "videoBitrateKbps": null,   // null với luồng radio
  "audioBitrateKbps": 128.4,
  "checkedAt": "2026-09-17T03:25:10.827Z"
}
```

`status` ánh xạ từ state nội bộ: `SUSPECT` khi luồng đang trong chu trình retry/debounce (xem mục 2.1) bất kể trạng thái xác nhận trước đó là gì; `HEALTHY`/`DEGRADED` phản ánh `rawStatus` đã XÁC NHẬN (`OK` hay `DEGRADED`/`DOWN`) khi không còn đang xác minh.

### 5.3. Trỏ domain trên Coolify

`Dockerfile` đã `EXPOSE 3000` sẵn — trên Coolify chỉ cần vào **Domains** của Application, thêm `falconhlsmonitor.vtcdigital.top` và trỏ vào port `3000` (cổng ứng dụng đang nghe, không phải cổng ngoài). Coolify (qua Traefik) tự cấp SSL và route domain vào đúng port này — dashboard, API và health check đều dùng chung 1 port nên không cần cấu hình thêm route nào khác.

---

## 6. Định dạng cảnh báo Telegram

**Khi phát hiện sự cố (đã qua debounce — xem mục 2.1), gửi đơn lẻ (≤ `alertBatching.minCountToDigest` sự cố trong `alertBatching.windowMs`):**
```
🔴 CẢNH BÁO: Luồng VOV2 mất kết nối!
🏷 Nguyên nhân: Lỗi luồng HLS thực sự
📉 Chi tiết: HTTP 404 khi lấy manifest
🔁 Đã xác nhận sau 3 lần kiểm tra liên tiếp
🕐 Thời điểm: 2026-09-17 10:00:00 (GMT+7)
```

**Khi nhiều luồng cùng gặp sự cố trong 1 khung `alertBatching.windowMs` (mặc định 10 giây), vượt `alertBatching.minCountToDigest` (mặc định 3) — gộp thành 1 tin duy nhất:**
```
🔴 CẢNH BÁO DIỆN RỘNG (Gộp)
Đang có 7 luồng gặp sự cố cùng lúc.
📉 Chi tiết: Kênh A (Mất track Video), Kênh B (ffprobe timeout...), Kênh C (HTTP 404 khi lấy manifest)...
🕐 Thời điểm: 2026-09-17 10:00:00 (GMT+7)
```

**Khi phục hồi (gửi ngay, không qua batching):**
```
🟢 PHỤC HỒI: Luồng VOV2 đã ổn định.
🕐 Thời điểm: 2026-09-17 10:05:00 (GMT+7)
```

> Cảnh báo `SYSTEM_OVERLOAD` (nghi ngờ chính hệ thống giám sát quá tải) **không bao giờ** xuất hiện ở Telegram — chỉ ghi log server + `diagnostic.log` (xem mục 2.1).

---

## 7. Lưu ý vận hành

- Nếu thiếu `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, hệ thống vẫn tiếp tục giám sát và ghi log đầy đủ, chỉ riêng bước gửi Telegram sẽ bị bỏ qua (log lỗi, không crash).
- Mọi lỗi từ `ffmpeg`/`ffprobe` (treo tiến trình, mạng chập chờn) đều có timeout cứng (`timeoutSeconds`) và được bắt tại từng lớp (`streamChecker`, `scheduler`), không làm sập toàn bộ tiến trình Node.js.
- Tỉ lệ lỗi giải mã (`packetLossPercentage`) là **giá trị ước lượng** (heuristic) dựa trên số dòng cảnh báo continuity/corrupt-frame mà `ffmpeg` in ra trong thời gian lấy mẫu (`ffprobeDurationSeconds`), không phải số đo packet loss ở tầng mạng (RTP/UDP). Phù hợp cho mục đích giám sát tương đối, không thay thế công cụ đo network chuyên dụng.
- Bitrate thực tế (Level 3) được đo bằng cách remux (không re-encode) nội dung ra `mpegts` trong bộ nhớ và tính `bytes*8 / thời-lượng-nội-dung` (ưu tiên lấy trực tiếp từ `bitrate=` do `ffmpeg` tự báo cáo) — **không** dùng thời gian tải mạng thực tế (wall-clock) làm mẫu số, vì CDN có thể trả dữ liệu nhanh hơn nhiều lần tốc độ phát thực (`speed=10-20x` khi cache tốt), dẫn đến số liệu sai lệch nếu tính theo wall-clock.
- Với luồng `"radio"`: hệ thống không decode/đo track Video dù luồng gốc có lẫn track video (ví dụ ảnh bìa/ID3 image) — chỉ Audio được kiểm tra so với `thresholds`.
