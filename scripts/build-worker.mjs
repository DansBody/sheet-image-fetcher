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

const replaceFromTo = (startMarker, endMarker, replacement, label) => {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Could not find start of ${label} in server.js.`);
  }

  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`Could not find end of ${label} in server.js.`);
  }

  source = source.slice(0, start) + replacement + source.slice(end);
};

replaceExact("import { fileURLToPath } from 'node:url';\n", '', 'the node:url import');

replaceExact(
  [
    'const __filename = fileURLToPath(import.meta.url);',
    'const __dirname = path.dirname(__filename);',
    '',
  ].join('\n'),
  '',
  'the __filename/__dirname setup',
);

replaceExact(
  [
    'app.use(',
    "  express.static(path.join(__dirname, 'public'), {",
    "    maxAge: '0',",
    '    setHeaders(res, filePath) {',
    "      if (/\\.(css|js)$/i.test(filePath)) {",
    "        res.setHeader('cache-control', 'no-cache');",
    '      }',
    '    },',
    '  }),',
    ');',
    '',
  ].join('\n'),
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
  [
    '    browser = await chromium.launch({',
    '      headless: true,',
    "      args: ['--disable-dev-shm-usage', '--no-sandbox'],",
    '    });',
  ].join('\n'),
  '    browser = await launch(env.BROWSER);',
  'the local Chromium launch block',
);

replaceExact(
  [
    '      for (const textUrl of extractImageReferencesFromText(variant)) {',
    '        const textResolved = resolveImageUrl(textUrl, baseUrl);',
    '        if (textResolved && isLikelyUsefulImageUrl(textResolved)) {',
    '          capturedUrls.add(textResolved);',
    '        }',
    '      }',
    '',
  ].join('\n'),
  '',
  'the browser response-text URL extraction loop',
);

replaceFromTo(
  "    page.on('response', async (response) => {",
  '\n\n    await navigateBrowserPage(page, url);',
  [
    "    page.on('response', (response) => {",
    '      const responseUrl = response.url();',
    '      const headers = response.headers();',
    "      const contentType = headers['content-type'] || '';",
    '',
    "      if (contentType.startsWith('image/') || isLikelyUsefulImageUrl(responseUrl)) {",
    '        addCapturedUrl(responseUrl, requestFrameUrl(response.request(), page));',
    '      }',
    '    });',
  ].join('\n'),
  'the browser response listener',
);

replaceFromTo(
  '    const finalUrl = page.url();',
  '\n  } catch (error) {',
  [
    '    const finalUrl = page.url();',
    '    const html = [...capturedUrls]',
    "      .map((imageUrl) => '<img src=\"' + escapeHtml(imageUrl) + '\" data-browser-captured=\"true\">')",
    "      .join('');",
    '',
    '    return {',
    '      capturedUrlCount: capturedUrls.size,',
    '      finalUrl,',
    '      html,',
    '    };',
  ].join('\n'),
  'the browser rendered-HTML return block',
);

replaceFromTo(
  "    document.querySelectorAll('*').forEach((element) => {",
  '\n\n    return [...found];',
  [
    "    document.querySelectorAll('img').forEach((image) => {",
    '      addUrlLikeValue(image.currentSrc);',
    '      addUrlLikeValue(image.src);',
    '      add(image.srcset);',
    '    });',
    '',
    "    document.querySelectorAll('source').forEach((source) => {",
    '      add(source.srcset);',
    '      addUrlLikeValue(source.src);',
    '    });',
    '',
    '    document',
    "      .querySelectorAll('[src],[data-src],[data-original],[data-lazy-src],[data-actualsrc],[data-img-url],[data-image]')",
    '      .forEach((element) => {',
    "        for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-img-url', 'data-image']) {",
    '          addUrlLikeValue(element.getAttribute(attr));',
    '        }',
    '      });',
    '',
    "    document.querySelectorAll('[srcset],[data-srcset],[data-lazy-srcset]').forEach((element) => {",
    "      for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) {",
    '        add(element.getAttribute(attr));',
    '      }',
    '    });',
    '',
    "    document.querySelectorAll('[style*=\"url(\"]').forEach((element) => {",
    "      add(element.getAttribute('style'));",
    '    });',
  ].join('\n'),
  'the browser DOM image collector',
);

replaceFromTo(
  'if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {',
  '\n\nfunction numberFromEnv',
  [
    'app.listen(port);',
    '',
    'export default httpServerHandler({ port });',
  ].join('\n'),
  'the local app.listen block',
);

const workerImports = [
  "import { env } from 'cloudflare:workers';",
  "import { httpServerHandler } from 'cloudflare:node';",
  "import { launch } from '@cloudflare/playwright';",
  '',
  '',
].join('\n');

await mkdir(outputDirUrl, { recursive: true });
await writeFile(outputUrl, workerImports + source, 'utf8');
console.log('Built Cloudflare Worker entry: dist/worker.js');
