# btc-sync Cloudflare Worker

Proxy giữa app BTC Dashboard và GitHub Contents API. Mục đích: app không cần PAT trên client.

## Deploy 1 lần (~5 phút)

### Bước 1: Tạo Worker
1. Vào https://dash.cloudflare.com (login bằng Google/email)
2. Sidebar trái → **Workers & Pages** → **Create** → **Hello World** template
3. Đặt tên (vd `btc-sync`) → **Deploy**
4. Bấm **Edit code** → xoá hết code mặc định
5. Mở file [worker.js](./worker.js) trong project → copy toàn bộ → paste vào editor
6. **Save and Deploy** (góc trên phải)

### Bước 2: Set environment variables
1. Worker vừa tạo → tab **Settings** → **Variables and Secrets**
2. Thêm 3 Variables (Type: Variable):
   | Name | Value |
   |------|-------|
   | `GH_OWNER` | `tommy31383` |
   | `GH_REPO` | `btc-dashboard` |
   | `GH_BRANCH` | `paper-data` |
3. Thêm 1 Secret (Type: Secret):
   | Name | Value |
   |------|-------|
   | `GH_PAT` | PAT của Tommy (scope: Contents read+write) |

### Bước 3: Lấy Worker URL
- Sau khi save, ở trang Worker overview thấy URL kiểu:
  `https://btc-sync.<your-subdomain>.workers.dev`
- Copy URL này

### Bước 4: Cấu hình URL trong app
- Mở file [utils/gistSync.ts](../utils/gistSync.ts)
- Tìm dòng `const WORKER_URL = ""`
- Paste URL Worker vào: `const WORKER_URL = "https://btc-sync.<your>.workers.dev"`
- Commit + push → Tommy gõ "build" → app deploy

### Bước 5: Test
Mở `https://btc-sync.<your>.workers.dev/health` trên browser → phải thấy:
```json
{"ok":true,"owner":"tommy31383","repo":"btc-dashboard","branch":"paper-data"}
```

## Bảo mật
- PAT lưu ở Cloudflare Secret, KHÔNG có trong code public
- Worker chỉ accept request từ allowed origins (Pages domain + localhost)
- Path validation: chặn `..`, chỉ cho `[a-zA-Z0-9_./-]`
- Free tier: 100,000 requests/day

## Endpoints (app gọi internal)
- `GET /file?path=X[&ref=branch]` — pull file
- `PUT /file?path=X` body `{message, content, sha?, branch?}` — push file
- `GET /ref?ref=heads/X` — read branch ref
- `POST /ref` body `{ref, sha}` — create branch
- `GET /health` — check Worker setup

## Đổi PAT sau này
Vào Cloudflare Worker → Settings → Variables and Secrets → Edit `GH_PAT`. Không cần build lại app.
