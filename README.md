# Sheet Image Fetcher

一個給 iPhone 捷徑搭配使用的小型圖片擷取器。輸入網頁 URL 後，服務會擷取 HTML 中可找到的圖片候選，顯示縮圖讓你勾選，最後把選到的圖片即時打包成 ZIP 下載。

選圖頁會自動辨識像 `1-7n4407f60e.jpg`、`24-5a4406f60e.jpg` 這類「序號 JPG」檔名，並提供快速篩選按鈕。

## 本機執行

```bash
npm install
npm run dev
```

開啟：

```text
http://localhost:3000
```

## 部署到 Render Free

1. 把這個專案推到 GitHub。
2. 到 Render 建立新的 Web Service，連到該 repo。
3. Render 會讀取 `render.yaml`：
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
4. 部署完成後會得到一個像這樣的網址：

```text
https://sheet-image-fetcher.onrender.com
```

## iPhone 捷徑設定

建立一個捷徑：

1. `取得剪貼簿`
2. `URL 編碼`
3. `開啟 URL`

開啟的 URL 格式：

```text
https://你的-render-網址/select?url=URL編碼後的剪貼簿
```

使用時先複製網頁 URL，再執行捷徑，就會開啟選圖頁。

## 預設限制

可用環境變數調整：

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `MAX_CANDIDATES` | `120` | 選圖頁最多顯示的候選圖片數 |
| `MAX_SELECTED` | `40` | 一次最多下載張數 |
| `MAX_IMAGE_BYTES` | `15728640` | 單張圖片最大大小，預設 15 MB |
| `MAX_TOTAL_BYTES` | `157286400` | 單次 ZIP 最大總量，預設 150 MB |
| `REQUEST_TIMEOUT_MS` | `15000` | 遠端請求逾時 |
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

限制：如果圖片完全由前端 JavaScript 在瀏覽器執行後才產生，第一版不會抓到。之後可以加 Playwright 模式處理這類網站。
