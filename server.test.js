import assert from 'node:assert/strict';
import test from 'node:test';
import { collectImageCandidates, extractImageReferencesFromText, isSerialJpgUrl } from './server.js';

test('extracts deeply nested image URLs from attributes, scripts, styles, and query params', () => {
  const html = `
    <html>
      <head>
        <style>
          .hero { background-image: url('/backgrounds/card.avif?size=large'); }
        </style>
      </head>
      <body>
        <div
          data-gallery='{"large":"https:\\/\\/cdn.example.com\\/photos\\/deep.jpg?x=1&amp;y=2"}'
          data-bg="/assets/promo.webp">
          <div>
            <img src="/_next/image?url=https%3A%2F%2Fimg.example.com%2Foriginal.png&w=1200&q=75">
          </div>
        </div>
        <script>
          window.__DATA__ = {"image":"https:\\/\\/cdn.example.com\\/nested\\/hero.jpg"};
        </script>
      </body>
    </html>
  `;

  const urls = collectImageCandidates(html, 'https://example.com/products/item').map((candidate) => candidate.url);

  assert(urls.includes('https://cdn.example.com/photos/deep.jpg?x=1&y=2'));
  assert(urls.includes('https://example.com/assets/promo.webp'));
  assert(urls.includes('https://img.example.com/original.png'));
  assert(urls.includes('https://example.com/backgrounds/card.avif?size=large'));
  assert(urls.includes('https://cdn.example.com/nested/hero.jpg'));
});

test('normalizes escaped image URLs in arbitrary text', () => {
  const refs = extractImageReferencesFromText('{"src":"https:\\/\\/images.example.com\\/a\\/photo.webp?width=900"}');

  assert.deepEqual(refs, ['https://images.example.com/a/photo.webp?width=900']);
});

test('detects serial jpg filenames used by gallery pages', () => {
  assert.equal(isSerialJpgUrl('https://cdn.example.com/gallery/1-7n4407f60e.jpg'), true);
  assert.equal(isSerialJpgUrl('https://cdn.example.com/gallery/24-5a4406f60e.jpg?width=1200'), true);
  assert.equal(isSerialJpgUrl('https://cdn.example.com/gallery/image-24.jpg'), false);
  assert.equal(isSerialJpgUrl('https://cdn.example.com/gallery/24-5a4406f60e.png'), false);
});

test('marks and boosts serial jpg candidates', () => {
  const html = `
    <img src="https://cdn.example.com/assets/logo.png">
    <img src="https://cdn.example.com/gallery/24-5a4406f60e.jpg">
  `;
  const candidates = collectImageCandidates(html, 'https://example.com/');

  assert.equal(candidates[0].url, 'https://cdn.example.com/gallery/24-5a4406f60e.jpg');
  assert.equal(candidates[0].serialJpg, true);
});
