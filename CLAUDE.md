# StreamGuard HLS — Ghi chú dự án

Hệ thống giám sát chủ động luồng HLS (TV + Radio), cảnh báo qua Telegram. Node.js/TypeScript, chạy nền, không có UI.

## Tech stack

- TypeScript + Node.js 20, biên dịch CommonJS (`tsconfig.json`).
- `axios` (HTTP), `p-queue@6` (worker queue, CJS), `winston` (log), `zod` (validate config), `ffmpeg`/`ffprobe` qua `child_process.spawn` trực tiếp (không dùng `fluent-ffmpeg`).
- Không dùng thư viện parse m3u8 ngoài — tự viết parser tối giản (`src/monitor/m3u8Parser.ts`) để kiểm soát type và tránh phụ thuộc thiếu type definition.

## Cấu trúc & vai trò module

```
src/
├── config/config.ts        # Load + validate config.json bằng zod (CONFIG_PATH env, mặc định ./config.json)
├── types/index.ts          # Toàn bộ type dùng chung
├── utils/time.ts           # formatVnTime() — format giờ GMT+7 cố định (Intl, KHÔNG phụ thuộc TZ host)
├── logger/logger.ts        # Winston, console pretty (dev) / JSON (prod), dùng formatVnTime cho timestamp
├── monitor/
│   ├── m3u8Parser.ts        # Parser HLS thủ công: media playlist, master playlist,
│   │                        #   EXT-X-MEDIA (audio rendition riêng), EXT-X-STREAM-INF AUDIO group-id
│   ├── manifestChecker.ts   # Level 1: HTTP GET .m3u8, đo latency, tự resolve master -> variant
│   │                        #   bandwidth cao nhất + audio rendition riêng nếu có
│   ├── freezeChecker.ts     # Level 2: so sánh media-sequence + segment cuối giữa 2 lần check
│   ├── streamChecker.ts     # HÀM THUẦN: chạy Level 1->2->3 một lần, trả StreamCheckResult.
│   │                        #   KHÔNG quyết định alert, KHÔNG ghi state - dùng lại được cho cả
│   │                        #   check định kỳ lẫn các lần retry.
│   ├── errorClassifier.ts   # Phân loại SYSTEM_OVERLOAD / NETWORK / STREAM từ 1 StreamCheckResult
│   ├── incidentManager.ts   # State machine SUSPECT -> retry -> xác nhận DEGRADED/DOWN -> AlertManager.
│   │                        #   Đây là nơi ra quyết định gửi alert (thay cho streamChecker cũ).
│   ├── eventLoopMonitor.ts  # Đo event-loop lag (drift sampling) + memory pressure (v8 heap_size_limit)
│   ├── stateStore.ts        # In-memory state per stream: lastStatus, phase (STABLE/SUSPECT),
│   │                        #   suspectAttempt, isChecking (chống chồng lấn), pendingRetryTimer...
│   └── scheduler.ts         # setInterval per stream + p-queue Level1/2 (maxConcurrentManifestChecks).
│                            #   Bỏ qua interval khi phase=SUSPECT hoặc isChecking=true.
├── ffmpeg/ffprobe.ts        # Level 3: đo bitrate thật + phát hiện lỗi giải mã (xem mục "Bẫy kỹ thuật").
│                            #   Có queue RIÊNG (configureFfprobeConcurrency) giới hạn maxConcurrentChecks,
│                            #   tách biệt hoàn toàn khỏi queue Level 1/2 trong scheduler.ts.
├── telegram/
│   ├── telegramBot.ts       # Build message MarkdownV2 (buildIncidentMessage, buildDigestMessage) + gửi qua Bot API
│   └── alertManager.ts      # Gom sự cố ĐÃ XÁC NHẬN trong alertBatching.windowMs, gộp thành 1 tin
│                            #   digest nếu > alertBatching.minCountToDigest, else gửi riêng lẻ.
├── web/server.ts            # Express: phục vụ public/index.html (dashboard) + GET /api/status (JSON)
│                            #   + GET /api/events (SSE, đẩy lại mỗi 3s) + GET /health (giữ cho Docker
│                            #   HEALTHCHECK). CHẠY CHUNG 1 PORT với API - không mở port riêng cho dashboard.
│                            #   Đã thay thế hoàn toàn monitor/healthServer.ts cũ (đã xóa file đó).
├── logger/
│   ├── logger.ts             # Log vận hành chính (console)
│   └── diagnosticLogger.ts   # Log riêng ra file diagnostic.log (JSON) - retry, executionMs, phân loại lỗi...
└── index.ts                 # Entry point, wiring (startEventLoopMonitor, configureFfprobeConcurrency,
                              #   configureAlertManager, startWebServer), xử lý SIGINT/SIGTERM (flush alert trước khi thoát)

public/index.html             # Dashboard tĩnh (HTML + Tailwind CDN + vanilla JS, KHÔNG qua build step của
                               #   tsc) - Dockerfile COPY riêng thư mục này vào image (COPY public ./public).
                               #   __dirname trong web/server.ts trỏ tới nó bằng "../../public" - luôn đúng
                               #   dù chạy qua ts-node-dev (src/web/server.ts) hay dist đã build
                               #   (dist/web/server.js), vì cả 2 đều cách project root đúng 2 cấp.
```

## Lệnh thường dùng

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm run dev          # ts-node-dev, hot reload
npm start            # node dist/index.js (sau build)
```

## File cấu hình — QUAN TRỌNG

- `config.example.json`: **có track trong git**, dùng làm mẫu.
- `config.json`: **nằm trong `.gitignore`**, chứa URL luồng thật của người dùng — KHÔNG bao giờ commit hay hiển thị công khai. Nếu cần sửa/test, sửa trực tiếp file local, không cần lo ảnh hưởng git.
- `.env`: cũng gitignore, chứa `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
- Schema validate bằng zod trong `config.ts` — mọi thay đổi cấu trúc config phải update cả `ConfigSchema` (zod) lẫn `AppConfig`/`StreamConfig` (types).

## Bẫy kỹ thuật đã gặp — đọc trước khi sửa `ffprobe.ts` hoặc `telegramBot.ts`

1. **`ffmpeg -f null -` KHÔNG BAO GIỜ cho bitrate thật** — muxer `null` không biết kích thước output nên field `bitrate=` trong stats luôn là `N/A`. Đây là bug từng khiến toàn bộ kiểm tra ngưỡng bitrate không hoạt động (không lỗi, không crash — chỉ âm thầm không bao giờ so sánh). Giải pháp hiện tại (`measureTrack` trong `ffprobe.ts`): chạy **1 lệnh ffmpeg với 2 output song song** — output copy ra `mpegts pipe:1` (có bitrate thật) + output `-f null -` (để bắt lỗi giải mã qua stderr). Không tách thành 2 lệnh riêng (tốn network fetch gấp đôi).

2. **`-t <duration>` phải lặp lại riêng cho MỖI output** khi dùng nhiều output trong 1 lệnh ffmpeg. Đặt 1 lần trước output đầu chỉ giới hạn output đó — output thứ 2 chạy vô thời hạn, treo tiến trình (đã tái hiện thực tế, phải `timeout`/`taskkill` để giải phóng khi debug).

3. **Bitrate phải tính theo thời lượng NỘI DUNG (PTS/`time=`), không phải wall-clock**. CDN cache có thể trả dữ liệu nhanh hơn tốc độ phát thực (`speed=10-20x`), nên `bytes / thời-gian-tải-thực-tế` cho ra số bị thổi phồng sai. Ưu tiên đọc trực tiếp `bitrate=` mà ffmpeg tự in (đã tính đúng theo content-time); chỉ fallback tự tính `bytes*8/contentSeconds` khi ffmpeg trả `N/A`.

4. **`ffmpeg` không in `frame=` khi decode audio thuần** (không có track video trong output) — nên số mẫu (`sampleCount`) dùng làm mẫu số packet-loss phải fallback sang đếm số lần xuất hiện `time=` khi không có `frame=`.

5. **Luôn dùng `-nostdin`** khi spawn ffmpeg từ code — nếu không, trong một số môi trường shell/CI, ffmpeg có thể chờ đọc stdin (tính năng "Press q to stop") và treo vô thời hạn dù không tương tác.

6. **Telegram `parse_mode: "MarkdownV2"` yêu cầu escape ký tự đặc biệt (`_ * [ ] ( ) ~ \` > # + - = | { } . !`) ở CẢ text tĩnh trong template, không chỉ phần nội suy** — quên escape `!`/`.` trong câu chữ cố định từng gây lỗi API 400 "can't parse entities" khiến **toàn bộ alert không gửi được** (không throw ra ngoài code, chỉ log lỗi âm thầm). Nếu thêm message mới, chạy `escapeMd()` cho MỌI biến nội suy VÀ tự kiểm tra text tĩnh không chứa ký tự reserved chưa escape.

7. **Giờ hiển thị (log + Telegram) phải dùng `formatVnTime()` (Intl với `timeZone: "Asia/Ho_Chi_Minh"`), không dùng `.toISOString()` hay `Date.now()` mặc định** — container Docker/Coolify thường chạy timezone UTC, `.toISOString()` luôn ra UTC bất kể host, gây lệch giờ khi đọc log/alert.

8. **`process.memoryUsage().heapUsed / heapTotal` là chỉ số NHIỄU cho phát hiện quá tải bộ nhớ — TUYỆT ĐỐI không dùng.** V8 cố tình giữ `heapTotal` sát `heapUsed`, nên tỉ lệ này thường xuyên ở mức 0.85-0.95 ngay cả khi hệ thống hoàn toàn bình thường (đã tái hiện thực tế khi test với 25 luồng thật: toàn bộ check bị phân loại nhầm `SYSTEM_OVERLOAD` dù event-loop lag chỉ 0-17ms). Dùng `v8.getHeapStatistics().heap_size_limit` (giới hạn heap THẬT trước khi OOM) làm mẫu số thay vì `heapTotal` — xem `eventLoopMonitor.ts::getMemoryPressure()`.

9. **Retry/suspect chỉ áp dụng cho category `NETWORK`/`STREAM`; category `SYSTEM_OVERLOAD` (ffprobe timeout, event-loop lag cao, áp lực bộ nhớ cao) không được tính vào `suspectAttempt` và không bao giờ gửi Telegram** — nếu sửa `incidentManager.ts`, giữ đúng nhánh rẽ này, nếu không sẽ vô tình biến lỗi hạ tầng giám sát thành cảnh báo giả cho khách hàng.

10. **`streamChecker.checkStream()` là hàm THUẦN (pure)** — không tự ý thêm side-effect (gọi Telegram, ghi `stateStore`) vào file này. Mọi quyết định trạng thái/alert thuộc về `incidentManager.ts`, vì `checkStream()` được gọi lại nhiều lần cho cùng 1 luồng trong lúc retry (không chỉ 1 lần/chu kỳ như trước).

## Loại luồng: `type: "tv" | "radio"`

- `"tv"` (mặc định): bắt buộc cả Video + Audio.
- `"radio"`: **bỏ qua hoàn toàn** việc decode/đo video trong `analyzeStream()` (không chỉ ẩn cảnh báo — tiết kiệm CPU thật). Audio bắt buộc.
- Master playlist tách audio riêng qua `#EXT-X-MEDIA` (rất phổ biến ở luồng broadcast thật, VD AC-3 5.1) được `manifestChecker.ts` tự resolve qua `findAudioRenditionForVariant()` — nếu bỏ qua bước này sẽ báo nhầm "Mất track Audio" cho variant chỉ chứa video.

## Trạng thái hiện tại

Đã hoàn thành đầy đủ theo yêu cầu gốc + nâng cấp "Deep Diagnostic" + Web Dashboard real-time: Level 1/2/3, cảnh báo Telegram, Docker + GitHub Actions → Coolify webhook, README chi tiết, hỗ trợ TV/Radio, đo bitrate chính xác, giờ GMT+7, phân loại nguyên nhân gốc rễ (SYSTEM_OVERLOAD/NETWORK/STREAM), debounce retry (SUSPECT state machine), queue ffprobe riêng + đo event-loop lag, AlertManager gộp tin nhắn, diagnostic.log riêng, Dashboard web dark-mode qua SSE (`src/web/server.ts` + `public/index.html`). Đã test thực tế bằng luồng Apple HLS test công khai + 25 luồng production thật của người dùng, và build/chạy thử Docker image thật (không chỉ unit test). Code đã push lên `https://github.com/canona/FalconHLS-Monitor` (public, nhánh `main`).

Chưa làm / có thể mở rộng thêm nếu được yêu cầu:
- Dashboard hiện là read-only (xem trạng thái), chưa có tương tác (VD nút "test lại ngay" cho 1 luồng, xác nhận đã đọc cảnh báo...).
- Lưu lịch sử check/incident vào DB (hiện tại state + diagnostic.log là nguồn duy nhất, in-memory state mất khi restart; diagnostic.log tồn tại qua restart nhưng chỉ append-only, không query được) — dashboard hiện chỉ hiển thị trạng thái TỨC THỜI, không có biểu đồ lịch sử theo thời gian.
- Dashboard chưa có xác thực (auth) — nếu domain public, ai có link đều xem được trạng thái giám sát. Cân nhắc thêm Basic Auth ở tầng Coolify/Traefik nếu cần riêng tư.
- Alert qua kênh khác ngoài Telegram (email, Slack, webhook chung).
- Threshold theo từng stream riêng (hiện `thresholds` là global cho toàn bộ streams).
- Test tự động (unit/integration) — hiện tại verify bằng chạy tay + script debug, chưa có test suite trong repo.
- `overloadStreak` (đếm số lần liên tiếp bị phân loại SYSTEM_OVERLOAD, trong `incidentManager.ts`) là biến `Map` in-memory riêng, KHÔNG nằm trong `StreamRuntimeState` — nếu cần persist/quan sát từ bên ngoài, phải expose thêm.

## Cách test nhanh (xem thêm README mục 3)

Dùng luồng test công khai của Apple để test không cần hạ tầng thật:
- TV: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8`
- Radio (audio-only thật, dùng để test `type: "radio"`): `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/a2/prog_index.m3u8`

`config.json` không track trong git nên có thể sửa thoải mái để test mà không sợ ảnh hưởng repo.
