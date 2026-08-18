import { mkdir, readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('../server.js', import.meta.url);
const outputDirUrl = new URL('../dist/', import.meta.url);
const outputUrl = new URL('../dist/worker.js', import.meta.url);

let source = await readFile(sourceUrl, 'utf8');

const replaceExact = (needle, replacement, label) => {
  if (!source.includes(needle)) {
    throw new Error(`Could not find ${label} in server.js.`);
  }
  source = source.replace(needle, replacement);
};

replaceExact("import { fileURLToPath } from 'node:url';\n", '', 'the node:url import');

replaceExact(
  `const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

`,
  '',
  'the __filename/__dirname setup',
);

replaceExact(
  `app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '0',
    setHeaders(res, filePath) {
      if (/\\.(css|js)$/i.test(filePath)) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  }),
);
`,
  '',
  'the local express.static middleware',
);

replaceExact(
  "const BROWSER_SCROLL_STEPS = numberFromEnv('BROWSER_SCROLL_STEPS', 10);",
  "const BROWSER_SCROLL_STEPS = numberFromEnv('BROWSER_SCROLL_STEPS', 5);",
  'the browser scroll default',
);

replaceExact("  const { chromium } = await import('playwright');\n", '', 'the Playwright import');

replaceExact(
  `    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });`,
  '    browser = await launch(env.BROWSER);',
  'the local Chromium launch block',
);

replaceExact(
  `async function fetchRenderedPage(url) {
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
}`,
  `async function fetchRenderedPage(url) {
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
    }
  };

  try {
    browser = await launch(env.BROWSER);

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

    page.on('response', (response) => {
      const responseUrl = response.url();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';

      if (contentType.startsWith('image/') || isLikelyUsefulImageUrl(responseUrl)) {
        addCapturedUrl(responseUrl, requestFrameUrl(response.request(), page));
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
    const html = [...capturedUrls]
      .map((imageUrl) => `<img src="${escapeHtml(imageUrl)}" data-browser-captured="true">`)
      .join('');

    return {
      capturedUrlCount: capturedUrls.size,
      finalUrl,
      html,
    };
  } catch (error) {
    throw new Error(`瀏覽器模式失敗：${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}`,
  'the fetchRenderedPage function',
);

replaceExact(
  `async function collectFrameImageUrls(frame, addCapturedUrl) {
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
}`,
  `async function collectFrameImageUrls(frame, addCapturedUrl) {
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

    document.querySelectorAll('img').forEach((image) => {
      addUrlLikeValue(image.currentSrc);
      addUrlLikeValue(image.src);
      add(image.srcset);
    });

    document.querySelectorAll('source').forEach((source) => {
      add(source.srcset);
      addUrlLikeValue(source.src);
    });

    document
      .querySelectorAll('[src],[data-src],[data-original],[data-lazy-src],[data-actualsrc],[data-img-url],[data-image]')
      .forEach((element) => {
        for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-img-url', 'data-image']) {
          addUrlLikeValue(element.getAttribute(attr));
        }
      });

    document.querySelectorAll('[srcset],[data-srcset],[data-lazy-srcset]').forEach((element) => {
      for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {
        add(element.getAttribute(attr));
      }
    });

    document.querySelectorAll('[style*="url("]').forEach((element) => {
      add(element.getAttribute('style'));
    });

    return [...found];
  }).catch(() => []);

  for (const rawUrl of urls) {
    addCapturedUrl(rawUrl, pageUrl);
  }
}`,
  'the collectFrameImageUrls function',
);

replaceExact(
  `if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(port, () => {
    console.log(\`Image fetcher listening on http://localhost:\${port}\`);
  });
}`,
  `app.listen(port);\n\nexport default httpServerHandler({ port });`,
  'the local app.listen block',
);

const workerImports = `import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { launch } from '@cloudflare/playwright';

`;

await mkdir(outputDirUrl, { recursive: true });
await writeFile(outputUrl, workerImports + source, 'utf8');
console.log('Built Cloudflare Worker entry: dist/worker.js');