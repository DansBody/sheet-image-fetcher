import { mkdir, readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('../server.js', import.meta.url);
const outputDirUrl = new URL('../dist/', import.meta.url);
const outputUrl = new URL('../dist/worker.js', import.meta.url);

let source = await readFile(sourceUrl, 'utf8');

const nodeFileUrlImport = "import { fileURLToPath } from 'node:url';\n";
if (!source.includes(nodeFileUrlImport)) {
  throw new Error('Could not find the node:url import in server.js.');
}
source = source.replace(nodeFileUrlImport, '');

const nodeFilePathSetup = `const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

`;
if (!source.includes(nodeFilePathSetup)) {
  throw new Error('Could not find the __filename/__dirname setup in server.js.');
}
source = source.replace(nodeFilePathSetup, '');

const localStaticMiddleware = `app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '0',
    setHeaders(res, filePath) {
      if (/\\.(css|js)$/i.test(filePath)) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  }),
);
`;
if (!source.includes(localStaticMiddleware)) {
  throw new Error('Could not find the local express.static middleware in server.js.');
}
source = source.replace(localStaticMiddleware, '');

const playwrightImport = "  const { chromium } = await import('playwright');\n";
if (!source.includes(playwrightImport)) {
  throw new Error('Could not find the Playwright import in server.js. Update scripts/build-worker.mjs to match the current source.');
}
source = source.replace(playwrightImport, '');

const localBrowserLaunch = `    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });`;
if (!source.includes(localBrowserLaunch)) {
  throw new Error('Could not find the local Chromium launch block in server.js.');
}
source = source.replace(localBrowserLaunch, '    browser = await launch(env.BROWSER);');

const localListenBlock = `if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(port, () => {
    console.log(\`Image fetcher listening on http://localhost:\${port}\`);
  });
}`;
if (!source.includes(localListenBlock)) {
  throw new Error('Could not find the local app.listen block in server.js.');
}
source = source.replace(
  localListenBlock,
  `app.listen(port);\n\nexport default httpServerHandler({ port });`,
);

const workerImports = `import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { launch } from '@cloudflare/playwright';

`;

await mkdir(outputDirUrl, { recursive: true });
await writeFile(outputUrl, workerImports + source, 'utf8');
console.log('Built Cloudflare Worker entry: dist/worker.js');
