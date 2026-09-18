# StreamGuard HLS — Ghi chú dự án

Hệ thống giám sát chủ động luồng HLS (TV + Radio), cảnh báo qua Telegram. Node.js/TypeScript, chạy nền, không có UI.

## Tech stack

- TypeScript + Node.js 20, biên dịch CommonJS (`tsconfig.json`).
- `axios` (HTTP), `p-queue@6` (worker queue, CJS), `winston` (log), `zod` (validate config), `ffmpeg`/`ffprobe` qua `child_process.spawn` trực tiếp (không dùng `fluent-ffmpeg`).
- Không dùng thư viện parse m3u8 ngoài — tự viết parser tối giản (`src/monitor/m3u8Parser.ts`) để kiểm soát type và tránh phụ thuộc thiếu type definition.

## Cấu trúc & vai trò module

```
src/
├── config/
│   ├── config.ts            # Load + validate config.json bằng zod (CONFIG_PATH env, mặc định ./config.json)
│   │                        #   Chỉ còn tham số VẬN HÀNH (threshold, retry, batching...) + staticStreams
│   │                        #   (optional, luồng khai báo tay) - danh sách luồng CHÍNH giờ đến từ Partner
│   │                        #   API (xem partners/streamSyncService.ts), không còn field `streams` bắt buộc.
│   └── partnerConfig.ts     # Parse VTC_PARTNER_KEYS ("ten:token,ten:token") + đọc PARTNER_API_BASE_URL/
│                            #   PARTNER_SYNC_INTERVAL_SECONDS (optional, có fallback mặc định).
├── types/index.ts          # Toàn bộ type dùng chung
├── utils/time.ts           # formatVnTime() — format giờ GMT+7 cố định (Intl, KHÔNG phụ thuộc TZ host)
├── logger/logger.ts        # Winston, console pretty (dev) / JSON (prod), dùng formatVnTime cho timestamp
├── partners/
│   ├── partnerApiClient.ts   # Gọi GET .../api/public/channels (header Authorization: Bearer <token>) cho
│   │                          #   1 Partner, validate TỪNG kênh bằng zod (1 kênh sai format bị bỏ qua, không
│   │                          #   hỏng cả danh sách), map thành StreamConfig[] (gắn partner + id).
│   └── streamSyncService.ts  # Sync worker: gọi lại TẤT CẢ Partner mỗi PARTNER_SYNC_INTERVAL_SECONDS (mặc
│                              #   định 5 phút). 1 Partner lỗi tạm thời chỉ bị log - GIỮ NGUYÊN danh sách
│                              #   kênh cũ của Partner đó (không xóa sạch vì 1 lần fetch fail) - xem "Bẫy
│                              #   kỹ thuật" #18.
├── monitor/
│   ├── m3u8Parser.ts        # Parser HLS thủ công: media playlist, master playlist,
│   │                        #   EXT-X-MEDIA (audio rendition riêng), EXT-X-STREAM-INF AUDIO group-id
│   ├── manifestChecker.ts   # Level 1: HTTP GET .m3u8, đo latency, tự resolve master -> variant
│   │                        #   bandwidth cao nhất + audio rendition riêng nếu có
│   ├── freezeChecker.ts     # Level 2: so sánh media-sequence + segment cuối giữa 2 lần check
│   ├── streamRegistry.ts    # Nguồn sự thật DUY NHẤT cho danh sách luồng đang giám sát (thay cho
│   │                        #   config.streams tĩnh cũ) - gồm staticStreams (partner="static") + luồng
│   │                        #   sync từ Partner API, khóa theo `id` (= `partner:name`) - xem "Bẫy kỹ
│   │                        #   thuật" #17. replacePartnerStreams() diff theo id, trả về added/removed
│   │                        #   để scheduler.ts đồng bộ interval runtime.
│   ├── streamChecker.ts     # HÀM THUẦN: chạy Level 1->2->3 một lần, trả StreamCheckResult.
│   │                        #   KHÔNG quyết định alert, KHÔNG ghi state - dùng lại được cho cả
│   │                        #   check định kỳ lẫn các lần retry.
│   ├── errorClassifier.ts   # Phân loại SYSTEM_OVERLOAD / NETWORK / STREAM từ 1 StreamCheckResult.
│   │                        #   NETWORK_ERROR_PATTERN bắt CẢ errno Node.js (ETIMEDOUT...) LẪN văn
│   │                        #   phong lỗi kết nối gốc của ffmpeg/ffprobe (Operation timed out,
│   │                        #   Connection to tcp...) - xem mục "Bẫy kỹ thuật" #11.
│   ├── incidentManager.ts   # State machine SUSPECT -> retry -> xác nhận DEGRADED/DOWN -> AlertManager.
│   │                        #   Đây là nơi ra quyết định gửi alert (thay cho streamChecker cũ).
│   │                        #   Chọn CHÍNH SÁCH RETRY riêng theo category qua getRetryPolicy():
│   │                        #   NETWORK dùng config.retry.network (kiên nhẫn hơn, backoff dài hơn),
│   │                        #   STREAM dùng config.retry gốc - xem mục "Bẫy kỹ thuật" #12.
│   ├── eventLoopMonitor.ts  # Đo event-loop lag (drift sampling) + memory pressure (v8 heap_size_limit)
│   ├── stateStore.ts        # In-memory state per stream (khóa theo `stream.id`, KHÔNG theo `name` - xem
│   │                        #   "Bẫy kỹ thuật" #17): lastStatus, phase (STABLE/SUSPECT), suspectAttempt,
│   │                        #   isChecking (chống chồng lấn), pendingRetryTimer... removeState(id) dọn
│   │                        #   state khi 1 kênh biến mất khỏi Partner API.
│   └── scheduler.ts         # setInterval per stream + p-queue Level1/2 (maxConcurrentManifestChecks).
│                            #   Bỏ qua interval khi phase=SUSPECT hoặc isChecking=true. Có 2 lịch
│                            #   ĐỘC LẬP: lịch chậm (checkIntervalSeconds, Level1->2->3 đầy đủ, qua
│                            #   runCheck) + lịch nhanh (fastCheckIntervalSeconds, CHỈ Level1+2, qua
│                            #   runFastProbe - watchdog phát hiện sớm manifest lỗi/đóng băng, KHÔNG
│                            #   BAO GIỜ tự ghi state, chỉ được phép kích hoạt sớm 1 lần runCheck đầy
│                            #   đủ) - xem "Bẫy kỹ thuật" #16. KHÔNG còn chạy 1 lần cố định lúc khởi động -
│                            #   trả về addStreams()/removeStream() để streamSyncService.ts thêm/bớt luồng
│                            #   runtime khi Partner API đổi danh sách kênh, không cần restart.
├── ffmpeg/ffprobe.ts        # Level 3: đo bitrate thật + phát hiện lỗi giải mã (xem mục "Bẫy kỹ thuật").
│                            #   2 lớp hàng đợi lồng nhau khi gọi analyzeStream(): hostQueue (per-
│                            #   hostname, configureHostConcurrency/maxConcurrentPerHost - chống origin
│                            #   rate-limit khi nhiều kênh chung 1 origin) rồi mới tới ffprobeQueue
│                            #   (tổng toàn hệ thống, configureFfprobeConcurrency/maxConcurrentChecks).
│                            #   KHÔNG còn hàm probeMetadata() riêng - measureTrack() tự đọc codec/
│                            #   sự tồn tại của track từ chính banner ffmpeg, gộp "đọc metadata" +
│                            #   "đo bitrate/lỗi giải mã" vào 1 tiến trình/track - xem "Bẫy kỹ thuật" #13.
├── telegram/
│   ├── telegramBot.ts       # Build message MarkdownV2 (buildIncidentMessage, buildDigestMessage) + gửi qua Bot API
│   └── alertManager.ts      # Gom sự cố ĐÃ XÁC NHẬN trong alertBatching.windowMs (mặc định 10s), gộp thành 1 tin
│                            #   digest nếu > alertBatching.minCountToDigest, else gửi riêng lẻ.
├── web/server.ts            # Express: phục vụ public/index.html (dashboard) + GET /api/status (JSON)
│                            #   + GET /api/events (SSE, đẩy lại mỗi 3s) + GET /health (giữ cho Docker
│                            #   HEALTHCHECK). CHẠY CHUNG 1 PORT với API - không mở port riêng cho dashboard.
│                            #   Đã thay thế hoàn toàn monitor/healthServer.ts cũ (đã xóa file đó).
├── logger/
│   ├── logger.ts             # Log vận hành chính (console)
│   └── diagnosticLogger.ts   # Log riêng ra file diagnostic.log (JSON) - retry, executionMs, phân loại lỗi...
└── index.ts                 # Entry point, wiring (startEventLoopMonitor, configureFfprobeConcurrency,
                              #   configureAlertManager, startWebServer, startPartnerSync), xử lý
                              #   SIGINT/SIGTERM (dừng scheduler + partnerSync, flush alert trước khi thoát)

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
- `config.json`: **nằm trong `.gitignore`**, chứa `staticStreams` (luồng khai báo tay, optional) + tham số
  vận hành (threshold, retry, batching...) — KHÔNG bao giờ commit hay hiển thị công khai. Nếu cần sửa/test,
  sửa trực tiếp file local, không cần lo ảnh hưởng git.
- `.env`: cũng gitignore, chứa `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` + `VTC_PARTNER_KEYS` (danh sách
  Partner + token, cú pháp `ten:token,ten:token` - xem `config/partnerConfig.ts`), tùy chọn
  `PARTNER_API_BASE_URL`/`PARTNER_SYNC_INTERVAL_SECONDS`.
- Schema validate bằng zod trong `config.ts` — mọi thay đổi cấu trúc config phải update cả `ConfigSchema` (zod) lẫn `AppConfig`/`StreamConfig` (types).
- Danh sách luồng KHÔNG còn nằm trong `AppConfig.streams` (đã xóa) - nguồn sự thật giờ là
  `monitor/streamRegistry.ts` (gộp `staticStreams` + kết quả sync từ Partner API).

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

11. **Lỗi kết nối gốc của ffmpeg/ffprobe (VD `Connection to tcp://host:443 failed: Operation timed out`) dùng văn phong HOÀN TOÀN khác errno Node.js** (`ETIMEDOUT`, `ECONNREFUSED`...) — nếu chỉ regex theo errno Node.js, toàn bộ lỗi kết nối tới origin sẽ rớt xuống nhánh mặc định và bị gắn nhầm là `STREAM` ("Lỗi luồng HLS thực sự") thay vì `NETWORK`. Đã tái hiện thực tế: 25 kênh cùng chung 1 origin (`catchup.truyenhinhso.vn`) bị chính origin/WAF rate-limit do quá nhiều kết nối TCP dồn dập, gây báo động sai dù người xem thật không thấy vấn đề gì. `NETWORK_ERROR_PATTERN` trong `errorClassifier.ts` phải bắt cả 2 lớp văn phong.

12. **KHÔNG dùng regex dò chữ "timeout" trên message để xác định `av.timedOut`** — dễ nhầm giữa 2 tình huống có ý nghĩa hoàn toàn khác nhau: (a) CHÍNH TA chủ động SIGKILL vì tiến trình không phản hồi kịp `timeoutSeconds` (dấu hiệu quá tải worker giám sát → `SYSTEM_OVERLOAD`, im lặng bỏ qua) và (b) ffmpeg TỰ báo lỗi kết nối tới origin kiểu "Operation timed out" (dấu hiệu mạng/origin, không phải máy giám sát quá tải → phải là `NETWORK`, có retry). Giải pháp: `ffprobe.ts` dùng `class WorkerTimeoutError extends Error` ném RIÊNG cho tình huống (a); `analyzeStreamInternal` dùng `err instanceof WorkerTimeoutError` (không phải regex) để set `timedOut`. Nếu sửa lại thành regex theo câu chữ, lỗi (b) sẽ bị gộp nhầm vào (a) và không bao giờ đi qua được chính sách retry NETWORK ở mục #14 dưới đây (xem `incidentManager.ts::getRetryPolicy`).

13. **Mỗi lần Level 3 check 1 kênh TV có audio rendition riêng (EXT-X-MEDIA) từng mở tới 4 tiến trình ffprobe/ffmpeg = 4 kết nối TCP riêng tới CÙNG origin** (2 `probeMetadata` + 2 `measureTrack`) — với nhiều kênh chung 1 origin, tổng kết nối đồng thời có thể lên hàng chục, dễ khiến origin/WAF rate-limit. Đã gộp: xóa hẳn `probeMetadata()`, để `measureTrack()` tự đọc codec/tình trạng track từ banner ffmpeg (`Stream #0:x: Video: ...` / `Audio: ...`) ngay trong tiến trình đo bitrate — giảm còn tối đa 2 tiến trình/kênh (video + audio). Kèm theo `hostQueue` (giới hạn `maxConcurrentPerHost`, mặc định 2) lồng bên ngoài `ffprobeQueue` (giới hạn `maxConcurrentChecks` tổng) trong `ffprobe.ts::analyzeStream()` để chặn đúng nguyên nhân gốc (quá nhiều kết nối dồn dập tới CÙNG 1 hostname), không chỉ giảm nhãn hiển thị.

14. **Retry/backoff KHÔNG còn dùng chung 1 chính sách cho mọi category** — `config.retry.network` (mặc định `maxRetries: 5`, `retryDelaysMs: [15000, 30000, 30000, 30000]`) áp dụng riêng cho category `NETWORK`, kiên nhẫn hơn hẳn `config.retry` gốc (mặc định `maxRetries: 3`, `[5000, 10000]`) dùng cho `STREAM` — vì lỗi kết nối origin cần thời gian dài hơn để origin/WAF "hạ nhiệt" trước khi hệ thống kết luận luồng đã chết. Nếu sửa `incidentManager.ts::processCheckResult`, luôn lấy policy qua `getRetryPolicy(category, config.retry)`, không đọc thẳng `config.retry.maxRetries`/`retryDelaysMs`.

15. **`alertBatching.windowMs` mặc định là 10s, KHÔNG phải 60s như bản gốc** — mặc định cũ (60s) khiến 1 kênh lỗi ĐƠN LẺ (trường hợp phổ biến nhất) luôn phải đợi đủ 60s trong buffer trước khi `flush()` quyết định gửi tin đơn lẻ, cộng thêm thời gian xác nhận qua retry (~15-30s) → độ trễ cảm nhận được giữa lúc dashboard báo lỗi và lúc Telegram thực sự nhận tin lên tới 1-2 phút (phát hiện qua phản hồi thực tế của người dùng). `flush()` đã sẵn logic gửi ngay dạng tin đơn lẻ khi buffer chỉ có 1 sự cố lúc hết hạn window — hạ `windowMs` xuống 10s giữ nguyên khả năng gộp digest khi có sự cố diện rộng (các kênh chung origin thường xác nhận lệch nhau vài giây do scheduler dàn đều lịch, không phải cùng lúc), nhưng giảm mạnh độ trễ cho trường hợp phổ biến. Nếu cần đổi lại, sửa qua `alertBatching.windowMs` trong config, KHÔNG sửa cứng trong code.

16. **`scheduler.ts::runFastProbe` (watchdog Level 1+2) CHỈ ĐƯỢC PHÉP kích hoạt sớm 1 lần `runCheck` đầy đủ, TUYỆT ĐỐI KHÔNG tự gọi `processCheckResult`/ghi state trực tiếp** — phát hiện khi điều tra nguyên nhân "4-6 phút mới thấy lỗi trên dashboard" (do `checkStream()` gộp cả Level1->2->3 vào 1 lịch duy nhất `checkIntervalSeconds`, trong khi Level1+2 chỉ cần HTTP GET nhẹ, hoàn toàn có thể chạy nhanh hơn mà không đụng origin). Lúc đầu định để watchdog tự cập nhật trạng thái OK/lỗi mỗi 15s cho nhanh, nhưng nhận ra nếu làm vậy, 1 kết quả "OK" từ Level1+2 (vốn KHÔNG hề kiểm tra Level 3) sẽ xóa mất tiến trình SUSPECT/retry đang tích lũy từ 1 lần kiểm tra Level 3 chậm hơn đang phát hiện tụt bitrate/mất track thật — vì Level1+2 "OK" không đồng nghĩa luồng thực sự ổn. Thiết kế đúng: watchdog chỉ ĐỌC state để quyết định có đáng kích hoạt sớm hay không (`phase === "STABLE" && lastStatus === "OK" && !isChecking`), và khi phát hiện bất thường chỉ gọi lại `runCheck()` - để `incidentManager` xử lý qua đúng state machine SUSPECT/retry như bình thường.

17. **Khóa định danh nội bộ của 1 luồng là `stream.id` (= `` `${partner}:${name}` ``), TUYỆT ĐỐI KHÔNG dùng `stream.name`** — trước khi có Partner API, `name` là khóa duy nhất trong `stateStore`/`scheduler`/`incidentManager` (kể cả `overloadStreak`) vì người vận hành tự đặt tên, không trùng. Từ khi luồng đến từ NHIỀU Partner khác nhau, 2 Partner hoàn toàn có thể đặt tên kênh trùng nhau (VD cả 2 đều có "VTV1") - nếu vẫn dùng `name` làm khóa, luồng sync sau sẽ ĐÈ state lên luồng của Partner kia (mất giám sát 1 trong 2 mà không có lỗi/log nào báo). `stream.name` vẫn dùng để HIỂN THỊ (log, Telegram, dashboard) như cũ, chỉ khóa Map là đổi.

18. **`streamSyncService.ts::syncOnce` KHÔNG được xóa danh sách kênh của 1 Partner chỉ vì 1 lần gọi API lỗi (timeout, 401, response sai format)** — dùng `Promise.allSettled` cho từng Partner, Partner nào `rejected` chỉ log lỗi, GIỮ NGUYÊN kênh cũ của Partner đó trong `streamRegistry` (không gọi `replacePartnerStreams`). Nếu đổi thành xóa sạch khi lỗi, 1 lần API của đối tác bị rớt mạng tạm thời (rất thường gặp, cùng bản chất với lỗi origin ở mục #11) sẽ khiến TOÀN BỘ kênh của đối tác đó biến mất khỏi dashboard + ngừng giám sát cho tới lần sync kế tiếp thành công.

19. **API Partner (VTVgo) KHÔNG cung cấp field loại luồng TV/Radio** — `partnerApiClient.ts` mặc định
    `type: "tv"` cho MỌI kênh từ Partner. Nếu 1 Partner thực sự có kênh radio, hệ thống sẽ cố decode
    Video cho kênh đó và báo nhầm "Mất track Video" liên tục (alert giả). CHƯA có cơ chế nhận diện radio
    tự động (VD dò theo tên kênh) - nếu cần, phải thêm logic riêng trong `partnerApiClient.ts` (hoặc yêu
    cầu Partner bổ sung field `type` vào response) TRƯỚC khi bật sync cho Partner có kênh radio thật.

20. **URL kéo luồng (`hls`) của VTVgo có thể đổi dù tên kênh (`name`, cũng là khóa `id`) không đổi** —
    khi VTVgo xoay `VTC_HLS_SECRET` (quy trình chuẩn khi lộ key, xem tài liệu tích hợp mục 5), token
    `?pull=...` trong `hls` đổi nhưng `name` giữ nguyên. `streamRegistry.ts::replacePartnerStreams` phải
    so sánh CẢ `url` (không chỉ diff theo `id`) để phát hiện trường hợp này, coi như gỡ bản cũ + thêm
    bản mới (đẩy vào CẢ `removed` lẫn `added`). `index.ts` phải gọi `scheduler.removeStream()` cho
    `removed` TRƯỚC `scheduler.addStreams(added)` - vì `addStreams()` bỏ qua id đã tồn tại (idempotent
    chống trùng interval), nếu thêm trước sẽ không có tác dụng và luồng bị kẹt lại URL cũ đã hết hiệu lực.

## Loại luồng: `type: "tv" | "radio"`

- `"tv"` (mặc định): bắt buộc cả Video + Audio.
- `"radio"`: **bỏ qua hoàn toàn** việc decode/đo video trong `analyzeStream()` (không chỉ ẩn cảnh báo — tiết kiệm CPU thật). Audio bắt buộc.
- Master playlist tách audio riêng qua `#EXT-X-MEDIA` (rất phổ biến ở luồng broadcast thật, VD AC-3 5.1) được `manifestChecker.ts` tự resolve qua `findAudioRenditionForVariant()` — nếu bỏ qua bước này sẽ báo nhầm "Mất track Audio" cho variant chỉ chứa video.

## Trạng thái hiện tại

Đã hoàn thành đầy đủ theo yêu cầu gốc + nâng cấp "Deep Diagnostic" + Web Dashboard real-time + Basic Auth + throttling theo host: Level 1/2/3, cảnh báo Telegram, Docker + GitHub Actions → Coolify webhook, README chi tiết, hỗ trợ TV/Radio, đo bitrate chính xác, giờ GMT+7, phân loại nguyên nhân gốc rễ (SYSTEM_OVERLOAD/NETWORK/STREAM), debounce retry (SUSPECT state machine) với CHÍNH SÁCH RIÊNG theo category (NETWORK kiên nhẫn hơn STREAM, xem "Bẫy kỹ thuật" #14), queue ffprobe riêng theo cả TỔNG (`maxConcurrentChecks`) lẫn PER-HOST (`maxConcurrentPerHost`, chống origin rate-limit khi nhiều kênh chung 1 origin) + đo event-loop lag, AlertManager gộp tin nhắn, diagnostic.log riêng, Dashboard web dark-mode qua SSE + Basic Auth tùy chọn (`src/web/server.ts` + `public/index.html`). Đã test thực tế bằng luồng Apple HLS test công khai + 25 luồng production thật của người dùng (phát hiện + sửa bug thật: origin `catchup.truyenhinhso.vn` bị rate-limit do 25 kênh mở quá nhiều kết nối TCP đồng thời), và build/chạy thử Docker image thật (không chỉ unit test). Code đã push lên `https://github.com/canona/FalconHLS-Monitor` (public, nhánh `main`).

Đã bổ sung **Dynamic Source Sync (đồng bộ luồng từ Partner API)**: `config.json::streams` tĩnh đã bị loại
bỏ, thay bằng `staticStreams` (optional, luồng khai báo tay) + đồng bộ định kỳ (mặc định 5 phút, xem
`partners/streamSyncService.ts`) từ API của từng Partner khai báo trong `VTC_PARTNER_KEYS` (`.env`). Mỗi
luồng giờ có `partner` + `id` (= `partner:name`, xem "Bẫy kỹ thuật" #17) - hiển thị thành Badge/Tag đối
tác + bộ lọc theo đối tác trên Dashboard (`public/index.html`), và tag `[TÊN_PARTNER]` trong tin Telegram
(`telegramBot.ts::formatChannelLabel`). Scheduler (`scheduler.ts`) đã refactor để `addStreams()`/
`removeStream()` runtime, không cần restart khi Partner API thêm/bớt kênh. Cấu trúc API Partner đã
**XÁC NHẬN THẬT** với VTVgo (tài liệu "14 — Tích hợp VTVgo") - response bọc trong `channels[]`, mỗi kênh
có `name`/`status`/`live`/`hls` (URL kéo luồng đã gắn token `?pull=...` không hết hạn, dùng thẳng) - xem
`partners/partnerApiClient.ts::PartnerApiChannelSchema`. API Partner **KHÔNG có field loại luồng
TV/Radio** - xem "Bẫy kỹ thuật" #19.

Chưa làm / có thể mở rộng thêm nếu được yêu cầu:
- Dashboard hiện là read-only (xem trạng thái), chưa có tương tác (VD nút "test lại ngay" cho 1 luồng, xác nhận đã đọc cảnh báo...).
- Lưu lịch sử check/incident vào DB (hiện tại state + diagnostic.log là nguồn duy nhất, in-memory state mất khi restart; diagnostic.log tồn tại qua restart nhưng chỉ append-only, không query được) — dashboard hiện chỉ hiển thị trạng thái TỨC THỜI, không có biểu đồ lịch sử theo thời gian.
- Dashboard đã có Basic Auth TÙY CHỌN (`DASHBOARD_USER`/`DASHBOARD_PASSWORD` trong `.env`, mặc định KHÔNG bật nếu thiếu 1 trong 2 biến) - xem `src/web/server.ts::basicAuthMiddleware`.
- Alert qua kênh khác ngoài Telegram (email, Slack, webhook chung).
- Threshold theo từng stream riêng (hiện `thresholds` là global cho toàn bộ streams).
- Test tự động (unit/integration) — hiện tại verify bằng chạy tay + script debug, chưa có test suite trong repo.
- `overloadStreak` (đếm số lần liên tiếp bị phân loại SYSTEM_OVERLOAD, trong `incidentManager.ts`) là biến `Map` in-memory riêng, KHÔNG nằm trong `StreamRuntimeState` — nếu cần persist/quan sát từ bên ngoài, phải expose thêm.

## Cách test nhanh (xem thêm README mục 3)

Dùng luồng test công khai của Apple để test không cần hạ tầng thật:
- TV: `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8`
- Radio (audio-only thật, dùng để test `type: "radio"`): `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/a2/prog_index.m3u8`

`config.json` không track trong git nên có thể sửa thoải mái để test mà không sợ ảnh hưởng repo.
