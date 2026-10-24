#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverExamples } from '../example-gallery/discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.pages-dist');
const manifest = JSON.parse(await readFile(path.join(output, 'api/examples.json'), 'utf8'));
const basePath = new URL(manifest.examples[0].entry, 'https://example.test').pathname
  .split('/example-gallery/')[0];
const sourceExamples = await discoverExamples(root);
assert.equal(manifest.count, sourceExamples.length);
assert.deepEqual(manifest.examples.map((example) => example.id), sourceExamples.map((example) => example.id));

const unprefixed = /\/(?:skills|example-gallery|node_modules)\//;
const sourceImport = /\b(?:from\s+|import\s*(?:\(\s*)?)(['"])([^'"\r\n]+)\1/g;
const visited = new Set();
let checkedImports = 0;

async function checkModule(filePath) {
  if (visited.has(filePath)) return;
  visited.add(filePath);
  assert.ok(existsSync(filePath), `Missing module: ${filePath}`);
  if (filePath.includes(`${path.sep}node_modules${path.sep}`)) return;

  const code = await readFile(filePath, 'utf8');
  for (const match of code.matchAll(sourceImport)) {
    const specifier = match[2];
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
    const href = specifier.split('?')[0];
    assert.ok(!specifier.includes('?raw'), `Raw import left in ${filePath}: ${specifier}`);
    assert.ok(!href.endsWith('.ts'), `TS browser import left in ${filePath}: ${specifier}`);
    let target;
    if (href.startsWith('/')) {
      assert.ok(href.startsWith(`${basePath}/`), `Unprefixed site import in ${filePath}: ${specifier}`);
      target = path.resolve(output, href.slice(basePath.length + 1));
    } else {
      target = path.resolve(path.dirname(filePath), href);
    }
    checkedImports += 1;
    assert.ok(existsSync(target) && statSync(target).isFile(),
      `Broken import ${specifier} in ${filePath}`);
    if (/\.(?:js|mjs)$/.test(target)) await checkModule(target);
  }
}

for (const example of manifest.examples) {
  assert.ok(example.entry.startsWith(`${basePath}/`));
  const address = new URL(example.entry, 'https://example.test');
  const runtimeFile = path.join(output, address.pathname.slice(basePath.length + 1));
  const moduleFile = path.join(output, address.searchParams.get('module').slice(basePath.length + 1));
  const thumbnail = path.join(output, example.thumbnail.slice(basePath.length + 1));
  assert.ok(existsSync(runtimeFile), `Missing runtime for ${example.id}`);
  assert.ok(existsSync(thumbnail), `Missing thumbnail for ${example.id}`);
  await checkModule(moduleFile);
}
for (const sharedModule of ['example-gallery/runtime/inspection-host.js', 'gallery/app.js']) {
  await checkModule(path.join(output, sharedModule));
}
for (const asset of [
  'index.html', '.nojekyll',
  'node_modules/three/build/three.webgpu.js',
  'node_modules/three-0180/build/three.webgpu.js',
  'node_modules/three-0186/build/three.webgpu.js',
]) assert.ok(existsSync(path.join(output, asset)), `Missing static asset: ${asset}`);

console.log(`PASS: ${manifest.count} examples, ${visited.size} modules, ${checkedImports} local imports resolved (${basePath}).`);

if (process.argv.includes('--browser')) {
  const { chromium } = await import('playwright');
  const mimeTypes = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.wgsl': 'text/plain',
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relativePath = decodeURIComponent(url.pathname);
    if (!relativePath.startsWith(`${basePath}/`)) {
      response.writeHead(404).end();
      return;
    }
    const resource = relativePath.slice(basePath.length + 1) || 'index.html';
    const filePath = path.resolve(output, resource);
    if (!filePath.startsWith(`${output}${path.sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404).end(`Missing: ${relativePath}`);
      return;
    }
    response.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const address = `http://127.0.0.1:${server.address().port}${basePath}/`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(address, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(expected => document.querySelector('#example-count')?.textContent?.startsWith(`${expected} `),
      manifest.count, { timeout: 15000 });
    const requestedExamples = process.argv.flatMap((arg, index, args) =>
      arg === '--example' && args[index + 1] ? [args[index + 1]] : []);
    const targetIds = requestedExamples.length ? requestedExamples : [
      'threejs-procedural-planets/procedural-planet-surface',
    ];
    for (const targetId of targetIds) {
      assert.ok(manifest.examples.some(example => example.id === targetId),
        `Unknown browser test example: ${targetId}`);
      await page.locator(`.example-link[data-example-id="${targetId}"]`).click();
      await page.locator('#example-frame').contentFrame()
        .locator("html[data-example-ready='true']").waitFor({ timeout: 40000 });
      assert.equal(errors.length, 0, `Browser errors for ${targetId}: ${errors.join('; ')}`);
      console.log(`PASS: browser gallery loaded and ${targetId} rendered without network or JavaScript errors.`);
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
