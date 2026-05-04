import archiver from 'archiver';
import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);

const USER_AGENT =
  process.env.FETCH_USER_AGENT ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const HTML_MAX_BYTES = numberFromEnv('HTML_MAX_BYTES', 5 * 1024 * 1024);
const MAX_CANDIDATES = numberFromEnv('MAX_CANDIDATES', 120);
const MAX_SELECTED = numberFromEnv('MAX_SELECTED', 40);
const MAX_IMAGE_BYTES = numberFromEnv('MAX_IMAGE_BYTES', 15 * 1024 * 1024);
const MAX_TOTAL_BYTES = numberFromEnv('MAX_TOTAL_BYTES', 150 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = numberFromEnv('REQUEST_TIMEOUT_MS', 15_000);
const ALLOW_PRIVATE_URLS = process.env.ALLOW_PRIVATE_URLS === 'true';

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/', (req, res) => {
  res.type('html').send(
    renderPage({
      title: '圖片擷取器',
      body: `
        <section class="hero">
          <div>
            <p class="eyebrow">iPhone Shortcut Image Fetcher</p>
            <h1>貼上網頁 URL，挑選要下載的圖片</h1>
            <p class="lead">適合搭配 iPhone 捷徑使用：捷徑讀取剪貼簿後開啟這個服務，接著在手機上勾選需要的圖片並下載 ZIP。</p>
          </div>
        </section>

        <form class="url-form" method="get" action="/select">
          <label for="url">網頁 URL</label>
          <div class="url-row">
            <input id="url" name="url" type="url" inputmode="url" autocomplete="url" placeholder="https://example.com/page" required>
            <button type="submit">搜尋圖片</button>
          </div>
        </form>
      `,
    }),
  );
});

app.get('/select', async (req, res) => {
  const inputUrl = String(req.query.url || '').trim();

  try {
    const pageUrl = await normalizeAndCheckUrl(inputUrl, '網頁 URL');
    const { html, finalUrl } = await fetchHtml(pageUrl);
    const candidates = collectImageCandidates(html, finalUrl).slice(0, MAX_CANDIDATES);

    res.type('html').send(
      renderPage({
        title: '選擇圖片',
        body: renderSelectionPage(finalUrl, candidates),
      }),
    );
  } catch (error) {
    res.status(400).type('html').send(
      renderPage({
        title: '無法擷取圖片',
        body: renderError(error.message, inputUrl),
      }),
    );
  }
});

app.get('/proxy', async (req, res) => {
  const inputUrl = String(req.query.url || '').trim();
  const referrer = String(req.query.ref || '').trim();

  try {
    const imageUrl = await normalizeAndCheckUrl(inputUrl, '圖片 URL');
    const referrerUrl = referrer ? await normalizeAndCheckUrl(referrer, '來源 URL') : undefined;
    const { response, buffer } = await fetchBufferWithLimit(imageUrl, {
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: imageRequestHeaders(referrerUrl),
    });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('cache-control', 'public, max-age=3600');
    res.type(contentType).send(buffer);
  } catch {
    res.status(404).type('text/plain').send('image unavailable');
  }
});

app.post('/download', async (req, res) => {
  const pageUrlInput = String(req.body.pageUrl || '').trim();
  const selectedImages = normalizeSelectedImages(req.body.images);

  if (selectedImages.length === 0) {
    res.status(400).type('html').send(
      renderPage({
        title: '尚未選擇圖片',
        body: renderError('請至少勾選一張圖片。', pageUrlInput),
      }),
    );
    return;
  }

  if (selectedImages.length > MAX_SELECTED) {
    res.status(400).type('html').send(
      renderPage({
        title: '選取太多圖片',
        body: renderError(`一次最多下載 ${MAX_SELECTED} 張圖片。`, pageUrlInput),
      }),
    );
    return;
  }

  try {
    const pageUrl = await normalizeAndCheckUrl(pageUrlInput, '來源 URL');
    const checkedImages = [];

    for (const imageUrl of selectedImages) {
      checkedImages.push(await normalizeAndCheckUrl(imageUrl, '圖片 URL'));
    }

    const safeName = buildZipName(pageUrl);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${safeName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (error) => {
      if (!res.headersSent) {
        res.status(500).end(error.message);
        return;
      }
      res.destroy(error);
    });

    archive.pipe(res);

    let totalBytes = 0;
    let added = 0;
    let index = 1;

    for (const imageUrl of checkedImages) {
      try {
        const { response, buffer } = await fetchBufferWithLimit(imageUrl, {
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers: imageRequestHeaders(pageUrl),
        });

        totalBytes += buffer.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error(`總下載大小超過 ${formatBytes(MAX_TOTAL_BYTES)}。`);
        }

        const contentType = response.headers.get('content-type') || '';
        const filename = buildImageName(index, imageUrl, contentType);
        archive.append(buffer, { name: filename });
        added += 1;
      } catch (error) {
        archive.append(`${imageUrl}\n${error.message}\n`, {
          name: `errors/image-${String(index).padStart(3, '0')}.txt`,
        });
      }

      index += 1;
    }

    if (added === 0) {
      archive.append('沒有任何圖片成功下載。請確認來源網站是否阻擋外部下載。\n', {
        name: 'errors/no-images-downloaded.txt',
      });
    }

    await archive.finalize();
  } catch (error) {
    res.status(400).type('html').send(
      renderPage({
        title: '無法下載圖片',
        body: renderError(error.message, pageUrlInput),
      }),
    );
  }
});

app.listen(port, () => {
  console.log(`Image fetcher listening on http://localhost:${port}`);
});

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchHtml(url) {
  const { response, buffer } = await fetchBufferWithLimit(url, {
    maxBytes: HTML_MAX_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-TW,zh;q=0.9,en;q=0.7',
      'user-agent': USER_AGENT,
    },
  });

  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error(`這個 URL 回傳的不是 HTML 頁面：${contentType}`);
  }

  return {
    html: buffer.toString('utf8'),
    finalUrl: response.url,
  };
}

async function fetchBufferWithLimit(url, { maxBytes, timeoutMs, headers }) {
  const response = await fetchWithSafeRedirects(url, {
    headers,
    timeoutMs,
  });

  if (!response.ok) {
    throw new Error(`遠端伺服器回應 ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new Error(`檔案超過大小限制 ${formatBytes(maxBytes)}。`);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`檔案超過大小限制 ${formatBytes(maxBytes)}。`);
    }
    return { response, buffer };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`檔案超過大小限制 ${formatBytes(maxBytes)}。`);
    }

    chunks.push(Buffer.from(value));
  }

  return {
    response,
    buffer: Buffer.concat(chunks, total),
  };
}

async function fetchWithSafeRedirects(url, { headers, timeoutMs }) {
  let currentUrl = await normalizeAndCheckUrl(url, 'URL');

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('遠端重新導向缺少 Location 標頭。');
        }

        currentUrl = await normalizeAndCheckUrl(new URL(location, currentUrl).toString(), '重新導向 URL');
        continue;
      }

      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('連線逾時。');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('重新導向次數過多。');
}

async function normalizeAndCheckUrl(input, label) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} 格式不正確。`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} 只支援 http 或 https。`);
  }

  url.hash = '';

  if (!ALLOW_PRIVATE_URLS) {
    await assertPublicHostname(url.hostname);
  }

  return url.toString();
}

async function assertPublicHostname(hostname) {
  const normalized = hostname.toLowerCase();

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('基於安全限制，不能擷取 localhost 或私有網路 URL。');
  }

  if (isPrivateOrLocalIp(normalized)) {
    throw new Error('基於安全限制，不能擷取私有網路 URL。');
  }

  if (net.isIP(normalized)) {
    return;
  }

  const records = await dns.lookup(normalized, { all: true });
  if (records.some((record) => isPrivateOrLocalIp(record.address))) {
    throw new Error('基於安全限制，不能擷取解析到私有網路的 URL。');
  }
}

function isPrivateOrLocalIp(value) {
  const version = net.isIP(value);

  if (version === 4) {
    const [first, second] = value.split('.').map((part) => Number(part));
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }

  if (version === 6) {
    const lower = value.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.')
    );
  }

  return false;
}

function collectImageCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidates = new Map();

  const push = (rawUrl, source, alt = '', width = '', height = '') => {
    const resolved = resolveImageUrl(rawUrl, pageUrl);
    if (!resolved) {
      return;
    }

    if (!candidates.has(resolved)) {
      candidates.set(resolved, {
        url: resolved,
        source,
        alt: String(alt || '').trim(),
        width: String(width || '').trim(),
        height: String(height || '').trim(),
        score: scoreImage(resolved, source, width, height),
      });
    }
  };

  $('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]').each(
    (_, element) => {
      push($(element).attr('content'), 'meta');
    },
  );

  $('img').each((_, element) => {
    const image = $(element);
    const alt = image.attr('alt') || image.attr('title') || '';
    const width = image.attr('width') || image.attr('data-width') || '';
    const height = image.attr('height') || image.attr('data-height') || '';

    for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-img-url', 'data-image']) {
      push(image.attr(attr), 'img', alt, width, height);
    }

    for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
      for (const srcsetUrl of parseSrcset(image.attr(attr))) {
        push(srcsetUrl, 'srcset', alt, width, height);
      }
    }
  });

  $('picture source, source').each((_, element) => {
    const source = $(element);
    for (const attr of ['srcset', 'data-srcset']) {
      for (const srcsetUrl of parseSrcset(source.attr(attr))) {
        push(srcsetUrl, 'source');
      }
    }
  });

  $('link[rel="image_src"], link[as="image"], link[rel="preload"][as="image"]').each((_, element) => {
    push($(element).attr('href'), 'link');
  });

  $('[style]').each((_, element) => {
    const style = $(element).attr('style') || '';
    const matches = style.matchAll(/url\((['"]?)(.*?)\1\)/gi);
    for (const match of matches) {
      push(match[2], 'background');
    }
  });

  return [...candidates.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

function resolveImageUrl(rawUrl, pageUrl) {
  if (!rawUrl) {
    return '';
  }

  const cleaned = String(rawUrl).trim().replace(/^['"]|['"]$/g, '');
  if (
    !cleaned ||
    cleaned.startsWith('#') ||
    /^(data|blob|javascript|mailto):/i.test(cleaned) ||
    cleaned === 'about:blank'
  ) {
    return '';
  }

  try {
    const url = new URL(cleaned, pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function parseSrcset(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function scoreImage(url, source, width, height) {
  let score = 0;
  const lower = url.toLowerCase();
  const numericWidth = Number(String(width).replace(/[^\d.]/g, ''));
  const numericHeight = Number(String(height).replace(/[^\d.]/g, ''));

  if (source === 'meta') score += 60;
  if (source === 'img' || source === 'srcset') score += 40;
  if (source === 'background') score += 20;
  if (/\.(jpe?g|png|webp|avif)(\?|$)/.test(lower)) score += 20;
  if (/\.(gif|svg)(\?|$)/.test(lower)) score += 8;
  if (Number.isFinite(numericWidth) && numericWidth >= 300) score += 15;
  if (Number.isFinite(numericHeight) && numericHeight >= 300) score += 15;
  if (/(icon|sprite|logo|avatar|tracking|pixel|spacer)/.test(lower)) score -= 30;

  return score;
}

function renderSelectionPage(pageUrl, candidates) {
  const candidateMarkup =
    candidates.length === 0
      ? `<div class="empty">沒有找到可下載的圖片候選。這個頁面可能由 JavaScript 動態載入圖片，或圖片來源被網站阻擋。</div>`
      : `
        <div class="toolbar">
          <div>
            <strong>${candidates.length}</strong> 張候選圖片
            <span class="muted">最多顯示 ${MAX_CANDIDATES} 張，一次最多下載 ${MAX_SELECTED} 張。</span>
          </div>
          <div class="toolbar-actions">
            <button type="button" data-select-all>全選</button>
            <button type="button" data-clear>清除</button>
          </div>
        </div>

        <form method="post" action="/download">
          <input type="hidden" name="pageUrl" value="${escapeHtml(pageUrl)}">
          <div class="grid">
            ${candidates
              .map(
                (candidate, index) => `
                  <label class="image-card">
                    <input type="checkbox" name="images" value="${escapeHtml(candidate.url)}">
                    <span class="thumb">
                      <img loading="lazy" src="/proxy?url=${encodeURIComponent(candidate.url)}&ref=${encodeURIComponent(pageUrl)}" alt="${escapeHtml(candidate.alt || '圖片預覽')}">
                    </span>
                    <span class="meta">
                      <span class="source">${escapeHtml(sourceLabel(candidate.source))}</span>
                      <span class="index">#${index + 1}</span>
                    </span>
                    <span class="url" title="${escapeHtml(candidate.url)}">${escapeHtml(trimUrl(candidate.url))}</span>
                  </label>
                `,
              )
              .join('')}
          </div>
          <div class="sticky-actions">
            <button type="submit">下載勾選圖片 ZIP</button>
          </div>
        </form>
      `;

  return `
    <section class="page-head">
      <a class="back-link" href="/">重新輸入 URL</a>
      <h1>選擇要下載的圖片</h1>
      <p class="source-url">${escapeHtml(pageUrl)}</p>
    </section>
    ${candidateMarkup}
  `;
}

function renderError(message, originalUrl) {
  const retryUrl = originalUrl ? `/?url=${encodeURIComponent(originalUrl)}` : '/';
  return `
    <section class="message">
      <h1>處理失敗</h1>
      <p>${escapeHtml(message)}</p>
      <a class="button-link" href="${retryUrl}">回首頁</a>
    </section>
  `;
}

function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
  <script defer src="/app.js"></script>
</head>
<body>
  <main class="shell">
    ${body}
  </main>
</body>
</html>`;
}

function normalizeSelectedImages(value) {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function imageRequestHeaders(referrer) {
  return {
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-language': 'zh-TW,zh;q=0.9,en;q=0.7',
    'user-agent': USER_AGENT,
    ...(referrer ? { referer: referrer } : {}),
  };
}

function buildZipName(pageUrl) {
  const { hostname } = new URL(pageUrl);
  const host = hostname.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'images';
  return `${host}-images.zip`;
}

function buildImageName(index, imageUrl, contentType) {
  const url = new URL(imageUrl);
  const fromPath = path.extname(url.pathname).replace(/[^a-z0-9.]/gi, '').slice(0, 12);
  const extension = fromPath || extensionFromContentType(contentType) || '.bin';
  return `image-${String(index).padStart(3, '0')}${extension}`;
}

function extensionFromContentType(contentType) {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  const extensions = {
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
  };
  return extensions[normalized] || '';
}

function sourceLabel(source) {
  const labels = {
    background: '背景',
    img: '圖片',
    link: '連結',
    meta: '預覽',
    source: '來源',
    srcset: '響應式',
  };
  return labels[source] || source;
}

function trimUrl(value) {
  const url = new URL(value);
  const text = `${url.hostname}${url.pathname}`;
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
