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
const ASSET_VERSION = encodeURIComponent(String(process.env.RENDER_GIT_COMMIT || Date.now()).slice(0, 12));

const USER_AGENT =
  process.env.FETCH_USER_AGENT ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const HTML_MAX_BYTES = numberFromEnv('HTML_MAX_BYTES', 5 * 1024 * 1024);
const MAX_CANDIDATES = numberFromEnv('MAX_CANDIDATES', 120);
const MAX_SELECTED = numberFromEnv('MAX_SELECTED', 40);
const MAX_IMAGE_BYTES = numberFromEnv('MAX_IMAGE_BYTES', 15 * 1024 * 1024);
const MAX_TOTAL_BYTES = numberFromEnv('MAX_TOTAL_BYTES', 150 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = numberFromEnv('REQUEST_TIMEOUT_MS', 15_000);
const BROWSER_FETCH_ENABLED = process.env.BROWSER_FETCH_ENABLED !== 'false';
const BROWSER_FETCH_DEFAULT = process.env.BROWSER_FETCH_DEFAULT === 'true';
const BROWSER_NAVIGATION_TIMEOUT_MS = numberFromEnv('BROWSER_NAVIGATION_TIMEOUT_MS', 30_000);
const BROWSER_SCROLL_STEPS = numberFromEnv('BROWSER_SCROLL_STEPS', 10);
const BROWSER_SCROLL_WAIT_MS = numberFromEnv('BROWSER_SCROLL_WAIT_MS', 700);
const BROWSER_MAX_CAPTURED_URLS = numberFromEnv('BROWSER_MAX_CAPTURED_URLS', 500);
const ALLOW_PRIVATE_URLS = process.env.ALLOW_PRIVATE_URLS === 'true';

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '0',
    setHeaders(res, filePath) {
      if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  }),
);

app.get('/', (req, res) => {
  res.type('html').send(
    renderPage({
      title: 'Score Snap',
      body: `
        <header class="app-header">
          <a class="app-logo" href="/">
            <span class="logo-icon">♪</span>
            <span class="logo-text">
              <span class="logo-name">SCORE SNAP</span>
              <span class="logo-tagline">SHEET MUSIC EXTRACTOR</span>
            </span>
          </a>
        </header>

        <div class="loading-overlay" id="loading-overlay" aria-hidden="true">
          <div class="spinner"></div>
          <div class="loading-label">Searching for images…</div>
        </div>

        <div class="home-shell">
          <div class="hero-card">
            <span class="hero-deco hero-deco-l" aria-hidden="true">𝄞</span>
            <span class="hero-deco hero-deco-r" aria-hidden="true">♩</span>
            <div class="hero-content">
              <img class="hero-mascot" src="/machi_sheet.png" alt="Machi the sheet music cat">
              <h1 class="hero-title">Paste a URL,<br>capture sheet music fast</h1>
              <p class="hero-lead">Extract, preview, and download sheet music images from any webpage.</p>

              <form class="url-form" method="get" action="/select">
                <div class="url-row">
                  <span class="url-icon" aria-hidden="true">🔗</span>
                  <input id="url" name="url" type="url" inputmode="url" autocomplete="url"
                    placeholder="Paste a webpage URL, e.g. https://example.com/page" required>
                  <button type="submit">Search Images</button>
                </div>
              </form>

              <p class="privacy-note">
                <span aria-hidden="true">🔒</span>
                Your data is safe. We don't store or share your URLs or files.
              </p>
            </div>
          </div>
        </div>
      `,
    }),
  );
});

app.get('/select', async (req, res) => {
  const inputUrl = String(req.query.url || '').trim();
  const browserMode = getBrowserMode(req.query.browser);

  try {
    const pageUrl = await normalizeAndCheckUrl(inputUrl, '網頁 URL');
    const { html, finalUrl } = await fetchHtml(pageUrl);
    let candidates = collectImageCandidates(html, finalUrl);
    let selectedFinalUrl = finalUrl;
    let browserAttempted = false;
    let browserUsed = false;
    let browserError = '';
    let capturedByBrowser = 0;

    if (shouldUseBrowserFetch(candidates, browserMode)) {
      browserAttempted = true;

      try {
        const rendered = await fetchRenderedPage(finalUrl);
        const renderedCandidates = collectImageCandidates(rendered.html, rendered.finalUrl);
        candidates = mergeCandidateLists(candidates, renderedCandidates);
        selectedFinalUrl = rendered.finalUrl;
        capturedByBrowser = rendered.capturedUrlCount;
        browserUsed = true;
      } catch (error) {
        browserError = error.message;
      }
    }

    candidates = candidates.slice(0, MAX_CANDIDATES);

    res.type('html').send(
      renderPage({
        title: 'Select Images',
        body: renderSelectionPage(selectedFinalUrl, candidates, {
          browserAttempted,
          browserEnabled: BROWSER_FETCH_ENABLED,
          browserError,
          browserMode,
          browserUsed,
          capturedByBrowser,
        }),
      }),
    );
  } catch (error) {
    res.status(400).type('html').send(
      renderPage({
        title: 'Error — Score Snap',
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
        title: 'Error — Score Snap',
        body: renderError('Please select at least one image.', pageUrlInput),
      }),
    );
    return;
  }

  if (selectedImages.length > MAX_SELECTED) {
    res.status(400).type('html').send(
      renderPage({
        title: 'Error — Score Snap',
        body: renderError(`You can download a maximum of ${MAX_SELECTED} images at once.`, pageUrlInput),
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
        title: 'Error — Score Snap',
        body: renderError(error.message, pageUrlInput),
      }),
    );
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(port, () => {
    console.log(`Image fetcher listening on http://localhost:${port}`);
  });
}

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

function getBrowserMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'html') {
    return 'html';
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'browser') {
    return 'browser';
  }
  return BROWSER_FETCH_DEFAULT ? 'auto' : 'html';
}

function shouldUseBrowserFetch(candidates, browserMode) {
  if (!BROWSER_FETCH_ENABLED) {
    return false;
  }

  if (browserMode === 'browser') {
    return true;
  }

  if (browserMode === 'html') {
    return false;
  }

  return !candidates.some((candidate) => candidate.targetGalleryJpg || candidate.serialJpg);
}

async function fetchRenderedPage(url) {
  const { chromium } = await import('playwright');
  const capturedUrls = new Set();
  const requestCheckCache = new Map();
  let browser;

  const addCapturedUrl = (value, baseUrl = url) => {
    if (capturedUrls.size >= BROWSER_MAX_CAPTURED_URLS) {
      return;
    }

    for (const variant of normalizeTextVariants(value)) {
      const resolved = resolveImageUrl(variant, baseUrl);
      if (resolved && isLikelyUsefulImageUrl(resolved)) {
        capturedUrls.add(resolved);
      }

      for (const embeddedUrl of extractNestedImageUrls(variant)) {
        const embeddedResolved = resolveImageUrl(embeddedUrl, baseUrl);
        if (embeddedResolved && isLikelyUsefulImageUrl(embeddedResolved)) {
          capturedUrls.add(embeddedResolved);
        }
      }

      for (const textUrl of extractImageReferencesFromText(variant)) {
        const textResolved = resolveImageUrl(textUrl, baseUrl);
        if (textResolved && isLikelyUsefulImageUrl(textResolved)) {
          capturedUrls.add(textResolved);
        }
      }
    }
  };

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });

    const context = await browser.newContext({
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      locale: 'zh-TW',
      userAgent: USER_AGENT,
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: {
        'accept-language': 'zh-TW,zh;q=0.9,en;q=0.7',
      },
    });

    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      const allowed = await isAllowedBrowserRequest(requestUrl, requestCheckCache);

      if (!allowed) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    const page = await context.newPage();

    page.on('request', (request) => {
      const requestUrl = request.url();
      if (request.resourceType() === 'image' || isLikelyUsefulImageUrl(requestUrl)) {
        addCapturedUrl(requestUrl, requestFrameUrl(request, page));
      }
    });

    page.on('response', async (response) => {
      const responseUrl = response.url();
      const requestType = response.request().resourceType();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const contentLength = Number(headers['content-length'] || 0);

      if (contentType.startsWith('image/') || isLikelyUsefulImageUrl(responseUrl)) {
        addCapturedUrl(responseUrl, requestFrameUrl(response.request(), page));
        return;
      }

      if (!['document', 'fetch', 'script', 'xhr'].includes(requestType)) {
        return;
      }

      if (contentLength > HTML_MAX_BYTES) {
        return;
      }

      if (!/(html|json|javascript|text|xml)/i.test(contentType)) {
        return;
      }

      try {
        addCapturedUrl(await response.text(), responseUrl);
      } catch {
        // Some response bodies are unavailable after the browser consumes them.
      }
    });

    await navigateBrowserPage(page, url);
    await waitForBrowserSettled(page);

    for (let index = 0; index < BROWSER_SCROLL_STEPS; index += 1) {
      await collectDomImageUrls(page, addCapturedUrl);
      await page.evaluate(() => {
        window.scrollBy(0, Math.max(window.innerHeight * 0.85, 500));
      });
      await page.waitForTimeout(BROWSER_SCROLL_WAIT_MS);
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    });
    await waitForBrowserSettled(page);
    await collectDomImageUrls(page, addCapturedUrl);

    const finalUrl = page.url();
    const renderedHtml = await collectRenderedHtml(page);
    const capturedMarkup = [...capturedUrls]
      .map((imageUrl) => `<img src="${escapeHtml(imageUrl)}" data-browser-captured="true">`)
      .join('');

    return {
      capturedUrlCount: capturedUrls.size,
      finalUrl,
      html: `${renderedHtml}${capturedMarkup}`,
    };
  } catch (error) {
    throw new Error(`瀏覽器模式失敗：${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function navigateBrowserPage(page, url) {
  try {
    await page.goto(url, {
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
      waitUntil: 'commit',
    });
  } catch (error) {
    if (!/Timeout/i.test(error.message)) {
      throw error;
    }

    // Some heavy viewer pages never reach DOMContentLoaded under automation, but
    // still expose useful network requests and partial DOM after the first commit.
    if (page.url() === 'about:blank') {
      throw error;
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
}

async function waitForBrowserSettled(page) {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(BROWSER_SCROLL_WAIT_MS);
}

async function collectDomImageUrls(page, addCapturedUrl) {
  for (const frame of page.frames()) {
    await collectFrameImageUrls(frame, addCapturedUrl);
  }
}

async function collectFrameImageUrls(frame, addCapturedUrl) {
  const pageUrl = frame.url();
  const urls = await frame.evaluate(() => {
    const found = new Set();

    const add = (value) => {
      if (!value) {
        return;
      }

      found.add(String(value));
    };

    const addUrlLikeValue = (value) => {
      if (!value) {
        return;
      }

      const text = String(value);
      add(text);

      if (/^(https?:)?\/\//i.test(text) || /^[/.]/.test(text)) {
        try {
          add(new URL(text, location.href).href);
        } catch {
          add(text);
        }
      }
    };

    document.querySelectorAll('*').forEach((element) => {
      for (const attr of element.getAttributeNames()) {
        const value = element.getAttribute(attr);
        if (/(src|href|url|image|img|poster|thumb|background|data)/i.test(attr) || /\.(jpe?g|png|webp|avif|gif|svg)([?#]|$)/i.test(value || '')) {
          addUrlLikeValue(value);
        }
      }

      const style = window.getComputedStyle(element);
      add(style.backgroundImage);
      add(style.content);
    });

    document.querySelectorAll('img').forEach((image) => {
      addUrlLikeValue(image.currentSrc);
      addUrlLikeValue(image.src);
      add(image.srcset);
    });

    document.querySelectorAll('source').forEach((source) => {
      add(source.srcset);
      addUrlLikeValue(source.src);
    });

    return [...found];
  }).catch(() => []);

  for (const rawUrl of urls) {
    addCapturedUrl(rawUrl, pageUrl);
  }
}

async function collectRenderedHtml(page) {
  const htmlParts = [];

  for (const frame of page.frames()) {
    try {
      htmlParts.push(await frame.content());
    } catch {
      // Cross-origin or detached frames can disappear while scrolling.
    }
  }

  return htmlParts.join('\n');
}

function requestFrameUrl(request, page) {
  try {
    return request.frame().url() || page.url();
  } catch {
    return page.url();
  }
}

async function isAllowedBrowserRequest(rawUrl, cache) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return true;
  }

  const cacheKey = `${url.protocol}//${url.hostname}`;
  if (!cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      normalizeAndCheckUrl(url.origin, '瀏覽器請求 URL')
        .then(() => true)
        .catch(() => false),
    );
  }

  return cache.get(cacheKey);
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

  const pushResolved = (rawUrl, source, alt = '', width = '', height = '') => {
    const resolved = resolveImageUrl(rawUrl, pageUrl);
    if (!resolved) {
      return;
    }

    const score = scoreImage(resolved, source, width, height);
    if (!candidates.has(resolved)) {
      candidates.set(resolved, {
        url: resolved,
        source,
        alt: String(alt || '').trim(),
        width: String(width || '').trim(),
        height: String(height || '').trim(),
        serialJpg: isSerialJpgUrl(resolved),
        targetGalleryJpg: isTargetGalleryJpgUrl(resolved),
        serialNumber: extractSerialNumber(resolved),
        score,
      });
      return;
    }

    const current = candidates.get(resolved);
    if (score > current.score) {
      current.source = source;
      current.width = String(width || '').trim();
      current.height = String(height || '').trim();
      current.score = score;
    }
    if (!current.alt && alt) {
      current.alt = String(alt).trim();
    }
  };

  const pushKnownUrl = (rawUrl, source, alt = '', width = '', height = '') => {
    for (const variant of normalizeTextVariants(rawUrl)) {
      pushResolved(variant, source, alt, width, height);
      for (const embeddedUrl of extractNestedImageUrls(variant)) {
        pushResolved(embeddedUrl, 'embedded', alt, width, height);
      }
    }
  };

  const pushTextUrls = (text, source, alt = '', width = '', height = '') => {
    for (const imageUrl of extractImageReferencesFromText(text)) {
      pushResolved(imageUrl, source, alt, width, height);
      for (const embeddedUrl of extractNestedImageUrls(imageUrl)) {
        pushResolved(embeddedUrl, 'embedded', alt, width, height);
      }
    }
  };

  $('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]').each(
    (_, element) => {
      pushKnownUrl($(element).attr('content'), 'meta');
    },
  );

  $('img').each((_, element) => {
    const image = $(element);
    const alt = image.attr('alt') || image.attr('title') || '';
    const width = image.attr('width') || image.attr('data-width') || '';
    const height = image.attr('height') || image.attr('data-height') || '';

    for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-img-url', 'data-image']) {
      pushKnownUrl(image.attr(attr), 'img', alt, width, height);
    }

    for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
      for (const srcsetUrl of parseSrcset(image.attr(attr))) {
        pushKnownUrl(srcsetUrl, 'srcset', alt, width, height);
      }
    }
  });

  $('picture source, source').each((_, element) => {
    const source = $(element);
    for (const attr of ['srcset', 'data-srcset']) {
      for (const srcsetUrl of parseSrcset(source.attr(attr))) {
        pushKnownUrl(srcsetUrl, 'source');
      }
    }
  });

  $('link[rel="image_src"], link[as="image"], link[rel="preload"][as="image"]').each((_, element) => {
    pushKnownUrl($(element).attr('href'), 'link');
  });

  $('[style]').each((_, element) => {
    pushTextUrls($(element).attr('style') || '', 'background');
  });

  $('*').each((_, element) => {
    const attributes = element.attribs || {};

    for (const [name, value] of Object.entries(attributes)) {
      if (!value) {
        continue;
      }

      const lowerName = name.toLowerCase();
      if (lowerName.includes('srcset')) {
        for (const srcsetUrl of parseSrcset(value)) {
          pushKnownUrl(srcsetUrl, 'srcset');
        }
      }

      if (/(src|href|url|image|img|poster|thumb|background|data)/i.test(lowerName)) {
        pushKnownUrl(value, 'attribute');
      }

      pushTextUrls(value, 'attribute');
    }
  });

  $('script').each((_, element) => {
    pushTextUrls($(element).html() || $(element).text() || '', 'script');
  });

  $('style').each((_, element) => {
    pushTextUrls($(element).html() || $(element).text() || '', 'style');
  });

  pushTextUrls(html, 'markup');

  for (const match of html.matchAll(/contentUrl:\s*"([^"]+)"/g)) {
    const derived = match[1].replace('/pages/', '/images/').replace('.jsonp', '.jpg');
    pushResolved(derived, 'scribd');
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

function mergeCandidateLists(...lists) {
  const candidates = new Map();

  for (const list of lists) {
    for (const candidate of list) {
      const current = candidates.get(candidate.url);
      if (!current || candidate.score > current.score) {
        candidates.set(candidate.url, candidate);
        continue;
      }

      if (!current.alt && candidate.alt) {
        current.alt = candidate.alt;
      }
      current.serialJpg = current.serialJpg || candidate.serialJpg;
      current.targetGalleryJpg = current.targetGalleryJpg || candidate.targetGalleryJpg;
    }
  }

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

function isLikelyUsefulImageUrl(value) {
  return (
    /\.(?:jpe?g|png|webp|avif|gif|svg)(?:[?#]|$)/i.test(String(value)) ||
    isSerialJpgUrl(value) ||
    isTargetGalleryJpgUrl(value)
  );
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

function extractImageReferencesFromText(text) {
  const found = new Set();

  for (const variant of normalizeTextVariants(text)) {
    const cssMatches = variant.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi);
    for (const match of cssMatches) {
      const imageUrl = cleanPossibleImageUrl(match[2]);
      if (imageUrl) {
        found.add(imageUrl);
      }
    }

    const absoluteMatches = variant.matchAll(/(?:https?:)?\/\/[^\s"'`<>\\)]+?\.(?:jpe?g|png|webp|avif|gif|svg)(?:[^\s"'`<>\\)]*)?/gi);
    for (const match of absoluteMatches) {
      const imageUrl = cleanPossibleImageUrl(match[0]);
      if (imageUrl) {
        found.add(imageUrl);
      }
    }

    const relativeMatches = variant.matchAll(/(?:\.{0,2}\/)?[a-z0-9_~@:%+./-]+?\.(?:jpe?g|png|webp|avif|gif|svg)(?:\?[^"'`<>\s\\)]*)?/gi);
    for (const match of relativeMatches) {
      if (isInsideAbsoluteUrl(variant, match.index || 0)) {
        continue;
      }

      const imageUrl = cleanPossibleImageUrl(match[0]);
      if (imageUrl && !imageUrl.includes('://')) {
        found.add(imageUrl);
      }
    }
  }

  return [...found];
}

function isInsideAbsoluteUrl(text, index) {
  if (index > 0 && text[index - 1] === '\\') {
    return true;
  }

  const prefix = text.slice(0, index);
  const lastDelimiter = Math.max(
    prefix.lastIndexOf(' '),
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf('\t'),
    prefix.lastIndexOf('"'),
    prefix.lastIndexOf("'"),
    prefix.lastIndexOf('`'),
    prefix.lastIndexOf('<'),
    prefix.lastIndexOf('>'),
    prefix.lastIndexOf('('),
    prefix.lastIndexOf(')'),
    prefix.lastIndexOf('\\'),
  );
  const currentToken = prefix.slice(lastDelimiter + 1);

  return /^(?:https?:)?\/\//i.test(currentToken);
}

function normalizeTextVariants(value) {
  if (!value) {
    return [];
  }

  const raw = String(value).trim();
  if (!raw) {
    return [];
  }

  const variants = new Set([raw]);
  const htmlDecoded = decodeCommonHtmlEntities(raw);
  variants.add(htmlDecoded);

  for (const text of [...variants]) {
    variants.add(
      text
        .replace(/\\\//g, '/')
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\u003[aA]/g, ':')
        .replace(/\\u0026/g, '&')
        .replace(/\\u003[dD]/g, '=')
        .replace(/\\u003[fF]/g, '?'),
    );
  }

  return [...variants].filter(Boolean);
}

function extractNestedImageUrls(rawUrl) {
  const nested = new Set();

  for (const variant of normalizeTextVariants(rawUrl)) {
    let url;
    try {
      url = new URL(variant, 'https://placeholder.local/');
    } catch {
      continue;
    }

    for (const value of url.searchParams.values()) {
      for (const nestedVariant of normalizeTextVariants(value)) {
        if (/\.(?:jpe?g|png|webp|avif|gif|svg)(?:[?#]|$)/i.test(nestedVariant)) {
          nested.add(nestedVariant);
        }

        for (const imageUrl of extractImageReferencesFromText(nestedVariant)) {
          nested.add(imageUrl);
        }
      }
    }
  }

  return [...nested];
}

function cleanPossibleImageUrl(value) {
  return decodeCommonHtmlEntities(String(value || ''))
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;]+$/g, '');
}

function decodeCommonHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/g, '/');
}

function scoreImage(url, source, width, height) {
  let score = 0;
  const lower = url.toLowerCase();
  const numericWidth = Number(String(width).replace(/[^\d.]/g, ''));
  const numericHeight = Number(String(height).replace(/[^\d.]/g, ''));

  if (source === 'scribd') score += 70;
  if (source === 'meta') score += 60;
  if (source === 'img' || source === 'srcset') score += 40;
  if (source === 'source' || source === 'link') score += 35;
  if (source === 'background') score += 20;
  if (source === 'attribute' || source === 'embedded') score += 18;
  if (source === 'script' || source === 'style' || source === 'markup') score += 10;
  if (/\.(jpe?g|png|webp|avif)([?#]|$)/.test(lower)) score += 20;
  if (/\.(gif|svg)([?#]|$)/.test(lower)) score += 8;
  if (isSerialJpgUrl(url)) score += 50;
  if (isTargetGalleryJpgUrl(url)) score += 35;
  if (Number.isFinite(numericWidth) && numericWidth >= 300) score += 15;
  if (Number.isFinite(numericHeight) && numericHeight >= 300) score += 15;
  if (/(icon|sprite|logo|avatar|tracking|pixel|spacer)/.test(lower)) score -= 30;

  return score;
}

function isSerialJpgUrl(value) {
  try {
    const url = new URL(value);
    const filename = decodeURIComponent(url.pathname.split('/').pop() || '');
    return /^\d{1,4}-[a-z0-9]+\.jpe?g$/i.test(filename);
  } catch {
    return false;
  }
}

function extractSerialNumber(value) {
  try {
    const filename = decodeURIComponent(new URL(value).pathname.split('/').pop() || '');
    const match = filename.match(/^(\d{1,4})-[a-z0-9]+\.jpe?g$/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function isTargetGalleryJpgUrl(value) {
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return /\/images\/\d{1,4}-[a-z0-9]+\.jpe?g$/i.test(pathname);
  } catch {
    return false;
  }
}

function renderSelectionPage(pageUrl, candidates, browserState = {}) {
  const targetGalleryJpgCount = candidates.filter((candidate) => candidate.targetGalleryJpg).length;
  const serialJpgCount = candidates.filter((candidate) => candidate.serialJpg).length;
  const browserStatus = renderBrowserStatus(pageUrl, browserState);

  const renderCard = (candidate, index) => {
    const displayNum =
      (candidate.serialJpg || candidate.targetGalleryJpg) && candidate.serialNumber != null
        ? candidate.serialNumber
        : index + 1;
    const fmt = getImageFormat(candidate.url);
    const dims = candidate.width && candidate.height ? `${candidate.width} × ${candidate.height}` : '';
    const metaParts = [dims, fmt].filter(Boolean).join(' · ');

    const proxySrc = `/proxy?url=${encodeURIComponent(candidate.url)}&ref=${encodeURIComponent(pageUrl)}`;
    return `
      <label class="image-card"
        data-serial-jpg="${candidate.serialJpg ? 'true' : 'false'}"
        data-target-gallery-jpg="${candidate.targetGalleryJpg ? 'true' : 'false'}">
        <input type="checkbox" name="images" value="${escapeHtml(candidate.url)}">
        <button type="button" class="zoom-btn" data-zoom-src="${proxySrc}" aria-label="Preview image">
          <svg width="13" height="13" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 6.5C10 8.433 8.433 10 6.5 10C4.567 10 3 8.433 3 6.5C3 4.567 4.567 3 6.5 3C8.433 3 10 4.567 10 6.5ZM9.33565 10.0197C8.56477 10.6439 7.57597 11 6.5 11C4.01472 11 2 8.98528 2 6.5C2 4.01472 4.01472 2 6.5 2C8.98528 2 11 4.01472 11 6.5C11 7.57597 10.6439 8.56477 10.0197 9.33565L12.8536 12.1464C13.0488 12.3417 13.0488 12.6583 12.8536 12.8536C12.6583 13.0488 12.3417 13.0488 12.1464 12.8536L9.33565 10.0197Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>
        </button>
        <span class="thumb">
          <img loading="lazy" src="${proxySrc}" alt="${escapeHtml(candidate.alt || 'Image preview')}">
        </span>
        <span class="card-label">Image #${displayNum}</span>
        ${metaParts ? `<span class="card-meta">${escapeHtml(metaParts)}</span>` : ''}
      </label>
    `;
  };

  const candidateMarkup =
    candidates.length === 0
      ? `<div class="empty-state">No downloadable images found on this page. The page may load images dynamically with JavaScript, or the source site may be blocking access.</div>`
      : `
        <div class="filter-bar" role="toolbar" aria-label="Filter images">
          <button class="filter-chip" type="button" data-filter="all" aria-pressed="true">
            All <span class="chip-count">${candidates.length}</span>
          </button>
          <button class="filter-chip" type="button" data-filter="target">
            Target Images <span class="chip-count">${targetGalleryJpgCount}</span>
          </button>
          <button class="filter-chip" type="button" data-filter="serial">
            Original JPG <span class="chip-count">${serialJpgCount}</span>
          </button>
          <div class="filter-sep" role="separator"></div>
          <button class="filter-chip" type="button" data-filter="checked">
            Selected <span class="chip-count chip-selected-count">0</span>
          </button>
        </div>

        <form method="post" action="/download">
          <input type="hidden" name="pageUrl" value="${escapeHtml(pageUrl)}">
          <div class="filter-empty is-hidden" data-filter-empty>
            No images match this filter.
          </div>
          <div class="grid">
            ${candidates.map((c, i) => renderCard(c, i)).join('')}
          </div>
          <div class="sticky-bar">
            <div class="sticky-bar-info">
              <div class="sticky-bar-count"><span data-selected-count>0</span> images selected</div>
            </div>
            <button type="button" class="sticky-clear-btn" data-clear>
              <svg width="14" height="14" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5.5 1C5.22386 1 5 1.22386 5 1.5C5 1.77614 5.22386 2 5.5 2H9.5C9.77614 2 10 1.77614 10 1.5C10 1.22386 9.77614 1 9.5 1H5.5ZM3 3.5C3 3.22386 3.22386 3 3.5 3H11.5C11.7761 3 12 3.22386 12 3.5C12 3.77614 11.7761 4 11.5 4H3.5C3.22386 4 3 3.77614 3 3.5ZM3.5 5C3.22386 5 3 5.22386 3 5.5C3 5.77614 3.22386 6 3.5 6H4V11.5C4 12.3284 4.67157 13 5.5 13H9.5C10.3284 13 11 12.3284 11 11.5V6H11.5C11.7761 6 12 5.77614 12 5.5C12 5.22386 11.7761 5 11.5 5H3.5ZM5 6H10V11.5C10 11.7761 9.77614 12 9.5 12H5.5C5.22386 12 5 11.7761 5 11.5V6Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>
              Clear Selection
            </button>
            <button type="submit" class="sticky-download-btn">
              <svg width="14" height="14" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M7.50005 1.04998C7.22391 1.04998 7.00005 1.27383 7.00005 1.54998V8.41371L5.45361 6.86727C5.25835 6.67201 4.94177 6.67201 4.74651 6.86727C4.55125 7.06253 4.55125 7.37911 4.74651 7.57437L7.14651 9.97437C7.24278 10.0706 7.37135 10.125 7.50005 10.125C7.62875 10.125 7.75732 10.0706 7.85359 9.97437L10.2536 7.57437C10.4488 7.37911 10.4488 7.06253 10.2536 6.86727C10.0583 6.67201 9.74177 6.67201 9.54651 6.86727L8.00005 8.41371V1.54998C8.00005 1.27383 7.77619 1.04998 7.50005 1.04998ZM2.50005 10C2.77619 10 3.00005 10.2239 3.00005 10.5V12C3.00005 12.5523 3.44776 13 4.00005 13H11C11.5523 13 12 12.5523 12 12V10.5C12 10.2239 12.2239 10 12.5 10C12.7762 10 13 10.2239 13 10.5V12C13 13.1046 12.1046 14 11 14H4.00005C2.8955 14 2.00005 13.1046 2.00005 12V10.5C2.00005 10.2239 2.22391 10 2.50005 10Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>
              Download Selected ZIP
            </button>
          </div>
        </form>
      `;

  return `
    <header class="app-header">
      <a class="app-logo" href="/">
        <span class="logo-icon">♪</span>
        <span class="logo-text">
          <span class="logo-name">SCORE SNAP</span>
          <span class="logo-tagline">SHEET MUSIC EXTRACTOR</span>
        </span>
      </a>
      <div class="header-url" title="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</div>
      <a class="header-action" href="/">↻ Search Again</a>
    </header>
    <div class="select-shell">
      ${browserStatus}
      ${candidateMarkup}
    </div>
  `;
}

function renderBrowserStatus(pageUrl, browserState) {
  const browserUrl = `/select?url=${encodeURIComponent(pageUrl)}&browser=1`;
  const staticUrl = `/select?url=${encodeURIComponent(pageUrl)}&browser=0`;

  if (browserState.browserUsed) {
    return `
      <div class="mode-status">
        <div>
          <strong>Browser mode active</strong>
          <span>Scrolled ${BROWSER_SCROLL_STEPS} times, captured ${browserState.capturedByBrowser || 0} additional image URLs.</span>
        </div>
        <a href="${staticUrl}">Switch to HTML mode</a>
      </div>
    `;
  }

  if (browserState.browserError) {
    return `
      <div class="mode-status mode-status-warn">
        <div>
          <strong>Browser mode failed</strong>
          <span>${escapeHtml(browserState.browserError)}</span>
        </div>
        <a href="${browserUrl}">Retry browser mode</a>
      </div>
    `;
  }

  return '';
}

function renderError(message, originalUrl) {
  const retryUrl = originalUrl ? `/?url=${encodeURIComponent(originalUrl)}` : '/';
  return `
    <header class="app-header">
      <a class="app-logo" href="/">
        <span class="logo-icon">♪</span>
        <span class="logo-text">
          <span class="logo-name">SCORE SNAP</span>
          <span class="logo-tagline">SHEET MUSIC EXTRACTOR</span>
        </span>
      </a>
    </header>
    <div class="select-shell">
      <div class="message-card">
        <h1>Something went wrong</h1>
        <p>${escapeHtml(message)}</p>
        <a class="btn-back" href="${retryUrl}">← Go back</a>
      </div>
    </div>
  `;
}

function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
  <script defer src="/app.js?v=${ASSET_VERSION}"></script>
</head>
<body>
  ${body}
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
    scribd: 'Scribd',
    background: '背景',
    attribute: '屬性',
    embedded: '內嵌',
    img: '圖片',
    link: '連結',
    meta: '預覽',
    markup: '標記',
    script: '腳本',
    source: '來源',
    srcset: '響應式',
    style: '樣式',
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

function getImageFormat(url) {
  try {
    const ext = path.extname(new URL(url).pathname).replace('.', '').toLowerCase();
    const map = { jpg: 'JPG', jpeg: 'JPG', png: 'PNG', webp: 'WebP', gif: 'GIF', avif: 'AVIF', svg: 'SVG' };
    return map[ext] || '';
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export { collectImageCandidates, extractImageReferencesFromText, isSerialJpgUrl, isTargetGalleryJpgUrl, resolveImageUrl };
