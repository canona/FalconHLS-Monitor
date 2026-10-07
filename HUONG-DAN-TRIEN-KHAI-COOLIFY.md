# HƯỚNG DẪN TRIỂN KHAI TRÊN COOLIFY — FalconHLS Monitor

> Đối tượng: người vận hành cần dựng FalconHLS Monitor (StreamGuard HLS) lên server Coolify (v4) trực tiếp từ GitHub.
> Repo: `https://github.com/canona/FalconHLS-Monitor` — nhánh `main`.
> Hướng dẫn sử dụng hằng ngày xem `HUONG-DAN-SU-DUNG.md`, chi tiết kỹ thuật xem `README.md`.

---

## Tổng quan

```
GitHub (main) ──push──> GitHub Actions (typecheck + build) ──webhook──> Coolify
                                                                          │
                                         build image từ Dockerfile (Node 20 + ffmpeg)
                                                                          │
                          container: port 3000  ── Dashboard / API / /health
                                     /app/config.json   (File mount - cấu hình vận hành)
                                     /app/logs          (Volume - diagnostic.log)
                                     Environment Vars   (Telegram, Partner token, Basic Auth...)
```

Những gì cần chuẩn bị **trước** khi bắt đầu:

| Thứ cần có | Dùng để làm gì |
|---|---|
| Server đã cài Coolify v4, truy cập được giao diện quản trị | Nơi chạy container |
| Domain (VD `falconhlsmonitor.vtcdigital.top`) đã trỏ bản ghi **A** về IP server Coolify | Truy cập Dashboard qua HTTPS |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Gửi cảnh báo (cách lấy: `README.md` mục Telegram) |
| Token Partner (VD VTVgo) | Đồng bộ danh sách kênh tự động (`VTC_PARTNER_KEYS`) |
| Quyền admin repo GitHub | Thêm Secrets cho GitHub Actions |

> Image tự cài sẵn `ffmpeg`/`ffprobe` — **không** cần cài gì thêm trên server.

---

## Bước 1 — Tạo Application từ GitHub

1. Đăng nhập Coolify → **Projects** → chọn (hoặc tạo) project, VD `Monitoring` → environment `production`.
2. Bấm **+ New** → chọn nguồn:
   - **Public Repository** (repo đang public): dán URL `https://github.com/canona/FalconHLS-Monitor`.
   - Hoặc **Private Repository (with GitHub App)** nếu repo chuyển sang private — làm theo hướng dẫn cài GitHub App của Coolify, sau đó chọn repo `FalconHLS-Monitor`.
3. Điền thông tin build:

   | Trường | Giá trị |
   |---|---|
   | Branch | `main` |
   | Build Pack | **Dockerfile** (KHÔNG chọn Nixpacks) |
   | Base Directory | `/` |
   | Dockerfile Location | `/Dockerfile` |
   | Ports Exposes | `3000` |

4. Bấm **Continue** / **Save** — Coolify tạo Application nhưng **chưa deploy vội**, làm tiếp các bước dưới trước.

---

## Bước 2 — Cấu hình domain

1. Mở Application → tab **General** → ô **Domains**: điền `https://falconhlsmonitor.vtcdigital.top`.
2. Không cần ghi cổng sau domain — Coolify (Traefik) tự route vào `Ports Exposes = 3000` và tự cấp SSL Let's Encrypt.
3. Dashboard, API (`/api/status`, `/api/events`) và `/health` dùng **chung 1 cổng** — không cần thêm route nào khác.

> SSE (`/api/events`) chạy tốt qua Traefik mặc định. Nếu đặt thêm Cloudflare proxy phía trước, dashboard vẫn tự fallback sang polling `/api/status`.

---

## Bước 3 — Khai báo biến môi trường

Mở tab **Environment Variables** → bấm **Developer view** (chế độ dán hàng loạt) → dán nội dung theo mẫu `.env.example`, thay bằng giá trị thật:

```env
TELEGRAM_BOT_TOKEN=<token-that-tu-BotFather>
TELEGRAM_CHAT_ID=<chat-id-that>

CONFIG_PATH=/app/config.json
LOG_LEVEL=info
PORT=3000
NODE_ENV=production
DIAGNOSTIC_LOG_PATH=/app/logs/diagnostic.log

DASHBOARD_USER=admin
DASHBOARD_PASSWORD=<mat-khau-manh>

VTC_PARTNER_KEYS=vtvgo:<token-vtvgo>
# PARTNER_API_BASE_URL=https://catchup.vtcrd.top/api/public/channels
# VTC_PARTNER_API_URLS=vtvgo:https://...,fpt:https://...
# PARTNER_SYNC_INTERVAL_SECONDS=300
```

Bảng tham chiếu:

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Có* | Thiếu → vẫn giám sát + ghi log, chỉ không gửi Telegram |
| `TELEGRAM_CHAT_ID` | Có* | Group/channel thường có id âm (`-100...`) |
| `CONFIG_PATH` | Không | Mặc định `./config.json` (= `/app/config.json` trong container) |
| `LOG_LEVEL` | Không | `info` cho production; `debug` khi cần điều tra |
| `PORT` | Không | Giữ `3000` — phải khớp `Ports Exposes` và `HEALTHCHECK` trong Dockerfile |
| `NODE_ENV` | Không | `production` → log dạng JSON |
| `DIAGNOSTIC_LOG_PATH` | Nên có | Trỏ vào volume `/app/logs` để log không mất sau redeploy (Bước 4) |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Nên có | Phải có **đủ cả 2** mới bật Basic Auth. Dashboard public trên Internet → nên bật |
| `VTC_PARTNER_KEYS` | Có nếu dùng Partner | Cú pháp `ten:token,ten:token`. Để trống nếu chỉ dùng `staticStreams` |
| `PARTNER_API_BASE_URL` | Không | URL API chung, mặc định `https://catchup.vtcrd.top/api/public/channels` |
| `VTC_PARTNER_API_URLS` | Không | URL API riêng từng Partner, cú pháp `ten:https://...,ten2:https://...` |
| `PARTNER_SYNC_INTERVAL_SECONDS` | Không | Chu kỳ sync danh sách kênh, mặc định `300` |

Lưu ý khi nhập trên Coolify:

- Với các biến chứa token/mật khẩu: **bỏ tick "Is Build Variable?"** (chỉ cần lúc chạy, không cần lúc build — tránh token lọt vào layer image/build log). Có thể tick **Is Literal?** nếu giá trị chứa ký tự `$`.
- Không bọc giá trị trong dấu nháy kép trong Developer view trừ khi giá trị chứa dấu cách.
- Sửa biến môi trường xong phải **Restart/Redeploy** thì container mới nhận giá trị mới.

---

## Bước 4 — Persistent Storage: `config.json` + thư mục log

Mở tab **Persistent Storage** (hoặc **Storages**) → **+ Add**.

### 4.1. File mount `config.json` — BẮT BUỘC

| Trường | Giá trị |
|---|---|
| Loại | **File Mount** |
| Destination Path | `/app/config.json` |
| Content | Nội dung `config.json` thật (lấy từ `config.example.json` rồi chỉnh) |

> ⚠️ Image đóng gói sẵn `config.example.json` làm `config.json` placeholder, trong đó có 2 kênh mẫu trỏ tới `example.com`. Nếu **quên** bước này, container vẫn chạy và `/health` vẫn pass, nhưng sẽ giám sát 2 URL giả → liên tục báo lỗi giả qua Telegram.

Ví dụ nội dung tối thiểu khi lấy toàn bộ kênh từ Partner API (không khai báo luồng tay):

```json
{
  "staticStreams": [],
  "checkIntervalSeconds": 30,
  "fastCheckIntervalSeconds": 15,
  "cooldownMinutes": 15,
  "timeoutSeconds": 10,
  "ffprobeDurationSeconds": 6,
  "maxConcurrentChecks": 5,
  "maxConcurrentManifestChecks": 10,
  "maxConcurrentPerHost": 2,
  "thresholds": {
    "minVideoBitrateKbps": 400,
    "minAudioBitrateKbps": 32,
    "maxPacketLossPercentage": 2,
    "maxManifestLatencyMs": 4000
  },
  "retry": {
    "maxRetries": 3,
    "retryDelaysMs": [5000, 10000],
    "network": { "maxRetries": 5, "retryDelaysMs": [15000, 30000, 30000, 30000] }
  },
  "alertBatching": { "windowMs": 10000, "minCountToDigest": 3 },
  "diagnostics": {
    "eventLoopLagThresholdMs": 200,
    "memoryHeapUsedRatioThreshold": 0.9,
    "ffprobeSlowThresholdMs": 8000
  }
}
```

Muốn giám sát thêm luồng khai báo tay (ngoài Partner), thêm vào `staticStreams`:

```json
{ "name": "VOV1", "url": "https://.../vov1/index.m3u8", "type": "radio" }
```

> `type` mặc định `"tv"` (bắt buộc cả Video + Audio). Kênh radio **phải** khai `"type": "radio"`, nếu không sẽ báo nhầm "Mất track Video". Kênh từ Partner API luôn được coi là `tv`.

### 4.2. Volume cho log — khuyến nghị

| Trường | Giá trị |
|---|---|
| Loại | **Volume Mount** |
| Name | `falconhls-logs` |
| Destination Path | `/app/logs` |

Kết hợp với `DIAGNOSTIC_LOG_PATH=/app/logs/diagnostic.log` ở Bước 3 → `diagnostic.log` (retry, thời gian ffprobe, phân loại lỗi) được giữ lại qua các lần redeploy. File tự xoay vòng 10 MB × 5 file.

---

## Bước 5 — Health check

`Dockerfile` đã khai báo sẵn:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
```

Trên tab **Healthcheck** của Coolify có thể bật thêm health check phía Traefik: Path `/health`, Port `3000`, Scheme `http`. `/health` **không** yêu cầu Basic Auth nên không cần khai báo user/pass ở đây. Endpoint này chỉ trả `{"status":"ok"}`, không chứa dữ liệu kênh — dữ liệu chi tiết nằm ở `/api/status` (có Basic Auth).

---

## Bước 6 — Deploy lần đầu

1. Bấm **Deploy** ở góc trên Application.
2. Theo dõi tab **Deployments** → log build. Lần đầu mất khoảng 1–3 phút (tải Node 20, `npm ci`, `tsc`, cài `ffmpeg`).
3. Khi trạng thái chuyển **Running (healthy)**, mở tab **Logs** — log khởi động bình thường gồm:
   - Đã load config, số `staticStreams`.
   - Sync Partner: số kênh lấy được từ từng Partner (VD `vtvgo`).
   - Web server lắng nghe cổng `3000`.

### Kiểm tra sau deploy

| Kiểm tra | Cách làm | Kết quả mong đợi |
|---|---|---|
| Health | `curl https://falconhlsmonitor.vtcdigital.top/health` | HTTP 200 + `{"status":"ok"}` |
| Dashboard | Mở domain trên trình duyệt | Hỏi đăng nhập (nếu bật Basic Auth) → danh sách kênh, Badge đối tác |
| API | `curl -u admin:<pass> https://.../api/status` | JSON danh sách luồng |
| Partner sync | Xem log container | Không có lỗi `401`/timeout khi gọi Partner API |
| Telegram | Tạm thêm 1 `staticStreams` URL sai, Restart | Sau ~30–60s nhận tin cảnh báo. Nhớ xóa luồng test đó đi |

---

## Bước 7 — Tự động deploy khi push lên `main`

Repo đã có sẵn `.github/workflows/deploy.yml`: mỗi lần push `main` → chạy `typecheck` + `build` → nếu pass thì gọi webhook Coolify để redeploy. Code lỗi type sẽ **không** được deploy.

### 7.1. Lấy Webhook URL + API Token trên Coolify

1. Application → tab **Webhooks** → copy **Deploy Webhook** (dạng `https://<coolify-host>/api/v1/deploy?uuid=<uuid>&force=false`).
2. Coolify v4 yêu cầu xác thực webhook: vào **Keys & Tokens** → **API Tokens** → tạo token mới, cấp quyền **deploy** → copy token (chỉ hiển thị 1 lần).
   - Nếu chưa thấy menu API Tokens: vào **Settings** → bật **API Access**.

### 7.2. Khai báo GitHub Secrets

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Giá trị |
|---|---|
| `COOLIFY_WEBHOOK_URL` | Deploy Webhook URL ở bước 7.1.1 |
| `COOLIFY_WEBHOOK_TOKEN` | API Token ở bước 7.1.2 (workflow tự gửi `Authorization: Bearer <token>`) |

> Thiếu `COOLIFY_WEBHOOK_URL` → job `deploy` báo lỗi đỏ trên tab Actions (cố ý, để không âm thầm bỏ qua deploy).

### 7.3. Tránh deploy 2 lần

Nếu tạo Application bằng **GitHub App** (Bước 1), Coolify có tính năng **Auto Deploy** riêng khi có push. Bật song song với workflow trên sẽ build 2 lần, và Auto Deploy của Coolify **không chờ typecheck**. Khuyến nghị: Application → **Advanced** → **tắt Auto Deploy**, chỉ dùng webhook từ GitHub Actions.

### 7.4. Kiểm tra

Push 1 commit nhỏ lên `main` → tab **Actions** trên GitHub thấy 2 job xanh → tab **Deployments** trên Coolify xuất hiện lần deploy mới.

---

## Vận hành sau triển khai

| Việc cần làm | Thao tác trên Coolify | Cần rebuild? |
|---|---|---|
| Sửa ngưỡng, retry, thêm/bớt `staticStreams` | **Persistent Storage** → sửa nội dung `/app/config.json` → **Restart** | Không |
| Thêm/đổi Partner, đổi token Telegram, đổi mật khẩu dashboard | **Environment Variables** → sửa → **Restart** | Không |
| Partner thêm/bớt kênh | Không cần làm gì — tự sync sau tối đa `PARTNER_SYNC_INTERVAL_SECONDS` | Không |
| Cập nhật code | Push lên `main` (tự deploy) hoặc bấm **Redeploy** | Có |
| Quay về bản cũ | Tab **Deployments** → chọn bản trước → **Rollback** | — |
| Xem log | Tab **Logs** (log vận hành); `diagnostic.log` trong volume `/app/logs` (mở **Terminal** của container → `tail -f /app/logs/diagnostic.log`) | — |

> Trạng thái giám sát (SUSPECT/retry, lần check cuối) nằm trong bộ nhớ — mỗi lần Restart/Redeploy sẽ bắt đầu lại từ đầu, các kênh hiện "đang xác minh" vài chục giây đầu là bình thường.

---

## Xử lý sự cố triển khai

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Build lỗi ở bước `npm run build` | Lỗi TypeScript trong code mới | Chạy `npm run typecheck` local, sửa rồi push lại |
| Container restart liên tục, log báo lỗi validate config | `config.json` sai cú pháp JSON hoặc sai schema (zod) | Kiểm tra lại nội dung File mount (thiếu dấu phẩy, sai tên field) |
| Dashboard chỉ có 2 kênh `Demo-TV-Channel` / `Demo-Radio-Channel` | Quên File mount `config.json` (Bước 4.1) | Thêm File mount → Restart |
| Không có kênh nào từ Partner | `VTC_PARTNER_KEYS` sai cú pháp / token sai (401) / API Partner không truy cập được từ server | Xem log `partner-config` / sync; thử `curl -H "Authorization: Bearer <token>" <PARTNER_API_BASE_URL>` từ Terminal container |
| Truy cập domain báo 404 / Bad Gateway | `Ports Exposes` khác `3000` hoặc domain chưa trỏ đúng IP | Sửa `Ports Exposes = 3000`, kiểm tra DNS |
| Không nhận Telegram | Thiếu/sai `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; bot chưa được thêm vào group | Kiểm tra biến, thêm bot vào group/channel (channel cần quyền admin) |
| Dashboard hỏi mật khẩu nhưng không đăng nhập được | Sai `DASHBOARD_USER`/`DASHBOARD_PASSWORD` hoặc chưa Restart sau khi sửa | Sửa biến → Restart |
| Hàng loạt kênh cùng origin báo lỗi `NETWORK` cùng lúc | Origin/WAF rate-limit IP server giám sát | Giảm `maxConcurrentPerHost` (VD `1`), tăng `checkIntervalSeconds`; nhờ phía origin whitelist IP server |
| GitHub Actions job `deploy` lỗi 401 | Thiếu/sai `COOLIFY_WEBHOOK_TOKEN` hoặc token không có quyền deploy | Tạo lại API Token có quyền deploy, cập nhật Secret |

---

## Checklist bảo mật

- [ ] Không commit `.env` / `config.json` thật lên git (đã có trong `.gitignore`).
- [ ] Token Telegram, token Partner, mật khẩu dashboard chỉ nằm trong Environment Variables của Coolify, **bỏ tick Build Variable**.
- [ ] Bật Basic Auth (`DASHBOARD_USER` + `DASHBOARD_PASSWORD`) vì dashboard hiển thị URL luồng có gắn token `?pull=...`.
- [ ] API Token Coolify chỉ cấp quyền **deploy**, lưu trong GitHub Secrets.
- [ ] Khi lộ token Partner: đổi token phía Partner → cập nhật `VTC_PARTNER_KEYS` → Restart.
