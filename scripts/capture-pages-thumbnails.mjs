#!/usr/bin/env node

// Optional authoring tool: capture real scene images for the static Pages gallery.
// Missing captures automatically use informative SVG fallbacks in build:pages.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { discoverExamples } from '../example-gallery/discovery.mjs';
import { startExampleGallery } from '../example-gallery/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleFilter = process.argv.includes('--example')
  ? process.argv[process.argv.indexOf('--example') + 1] : null;
const outputPath = path.join(root, 'example-gallery/previews');
await mkdir(outputPath, { recursive: true });
const examples = (await discoverExamples(root)).filter(example =>
  !exampleFilter || example.id.includes(exampleFilter));
if (!examples.length) throw new Error('No matching examples found.');

const { server, url } = await startExampleGallery({ host: '127.0.0.1', port: 0 });
let browser;
let successes = 0;
let failures = 0;
try {
  // Reuse the machine's installed Chrome; no extra Playwright browser download.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 800, height: 450 }, deviceScaleFactor: 1,
  });
  for (const example of examples) {
    const page = await context.newPage();
    const target = new URL(example.entry, url);
    target.searchParams.set('galleryThumbnail', '1');
    target.searchParams.set('galleryDpr', '1');
    target.searchParams.set('galleryPaused', '1');
    target.searchParams.set('galleryDebugMode', 'final');
    if (/^webgpu/i.test(example.backend)) target.searchParams.set('galleryBackend', 'webgpu');

    try {
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator("html[data-example-ready='true']").waitFor({ timeout: 20000 });
      await page.locator('canvas').screenshot({
        type: 'jpeg', quality: 82,
        path: path.join(outputPath, example.id.replace(/[^a-z0-9-]/gi, '_').toLowerCase() + '.jpg'),
      });
      console.log(`Captured ${example.id}`);
      successes += 1;
    } catch (error) {
      console.warn(`Skipped ${example.id}: ${error.message.split('\n')[0]}`);
      failures += 1;
    } finally {
      await page.close();
    }
  }
  console.log(`Captured ${successes}/${examples.length} scenes (${failures} unavailable).`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
