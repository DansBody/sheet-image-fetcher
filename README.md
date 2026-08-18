# Sheet Image Fetcher / Score Snap

一個給 iPhone 捷徑搭配使用的小型圖片擷取器。輸入網頁 URL 後，服務會擷取 HTML 中可找到的圖片候選，顯示縮圖讓你勾選，最後把選到的圖片即時打包成 ZIP 下載。

選圖頁會自動辨識像 `1-7n4407f60e.jpg`、`24-5a4406f60e.jpg` 這類「序號 JPG」檔名；如果 URL 形如 `/images/24-5a4406f60e.jpg`，會再標成「目標圖片」並提供快速篩選按鈕。

## 本機執行

```bash
npm install
npm run dev
```

如果要在本機測試瀏覽器模式，先安裝 Chromium：

```bash
npx playwright install chromium
```

開啟：

```text
http://localhost:3000
```

## Cloudflare Workers

專案已包含 `wrangler.jsonc`，並使用 Cloudflare Workers Static Assets 與 Browser Run binding。

先安裝依賴：

```bash
npm install
```

本機測試 Worker：

```bash
npm run worker:dev
```

直接部署：

```bash
npm run deploy
```

### 從 GitHub 自動部署

在 Cloudflare Dashboard 的 Workers & Pages 建立 Worker 並連接這個 GitHub repo：

- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

`npm run build` 會從目前的 `server.js` 產生 Cloudflare 專用的 `dist/worker.js`。這個產物不需要 commit 到 Git。

Cloudflare 版本使用 `@cloudflare/playwright` + Browser Run；本機 Node 版本仍使用一般 `playwright`，因此原本的開發方式可以保留。

## iPhone 捷徑設定

建立一個捷徑：

1. `取得剪貼簿`
2. `URL 編碼`
3. `開啟 URL`

開啟的 URL 格式：

```text
https://你的-workers-dev-網址/select?url=URL編碼後的剪貼簿
```

沒有帶 `browser` 參數時，目前預設使用快速 HTML mode。

明確使用 Browser Run：

```text
https://你的-workers-dev-網址/select?url=URL編碼後的剪貼簿&browser=1
```

明確只抓初始 HTML：

```text
https://你的-workers-dev-網址/select?url=URL編碼後的剪貼簿&browser=0
```

## 預設限制

可用環境變數調整：

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `MAX_CANDIDATES` | `120` | 選圖頁最多顯示的候選圖片數 |
| `MAX_SELECTED` | `40` | 一次最多下載張數 |
| `MAX_IMAGE_BYTES` | `15728640` | 單張圖片最大大小，預設 15 MB |
| `MAX_TOTAL_BYTES` | `157286400` | 單次 ZIP 最大總量，預設 150 MB |
| `REQUEST_TIMEOUT_MS` | `15000` | 遠端請求逾時 |
| `BROWSER_FETCH_ENABLED` | `true` | 是否啟用瀏覽器擷取模式 |
| `BROWSER_FETCH_DEFAULT` | `false` | 沒有指定 `browser` 參數時，是否預設使用瀏覽器模式 |
| `BROWSER_NAVIGATION_TIMEOUT_MS` | `30000` | 瀏覽器開頁逾時 |
| `BROWSER_SCROLL_STEPS` | `10` | 瀏覽器模式往下捲動次數 |
| `BROWSER_SCROLL_WAIT_MS` | `700` | 每次捲動後等待毫秒數 |
| `BROWSER_MAX_CAPTURED_URLS` | `500` | 瀏覽器模式最多額外捕捉的圖片 URL |
| `ALLOW_PRIVATE_URLS` | `false` | 是否允許抓取 localhost / 私有網路 |

## 目前支援的圖片來源

- `img src`
- `img srcset`
- 常見 lazy-load 屬性，例如 `data-src`、`data-original`
- `picture source srcset`
- `og:image`、`twitter:image`
- inline style 裡的 `background-image: url(...)`
- 所有元素屬性中的圖片 URL，例如 `data-*`、`poster`、`background`
- `script` / `style` / HTML 原始文字裡的 `.jpg`、`.png`、`.webp`、`.avif` 等 URL
- JSON 轉義格式，例如 `https:\/\/example.com\/image.jpg`
- query string 內嵌的原始圖片 URL，例如 `/_next/image?url=https%3A%2F%2F...%2Fimage.jpg`
- Browser mode：開啟頁面、等待 JavaScript、往下捲動，並收集 DOM 與 network request 裡的圖片 URL

限制：如果圖片需要登入、手動點擊展開、或網站阻擋自動化瀏覽器，仍可能抓不到。
