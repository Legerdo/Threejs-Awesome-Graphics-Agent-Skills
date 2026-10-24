#!/usr/bin/env node

// Export the development gallery as a standalone, serverless Pages site.
// The directory layout is retained so scene-relative assets continue working.
import { existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { discoverExamples } from '../example-gallery/discovery.mjs';
import { inspectionRuntimeDocument } from '../example-gallery/runtime/renderer-imports.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, '.pages-dist');
const defaultBase = '/Threejs-Awesome-Graphics-Agent-Skills';
const baseArgument = process.argv.indexOf('--base');
if (baseArgument !== -1 && !process.argv[baseArgument + 1]) {
  throw new Error('--base must be followed by a site path such as /repo-name.');
}
const requestedBase = baseArgument === -1 ? defaultBase : process.argv[baseArgument + 1];
if (!/^\/(?:[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*)?\/?$/.test(requestedBase)) {
  throw new Error(`Invalid site path: ${requestedBase}`);
}
const basePath = requestedBase.replace(/\/$/, '');
const sitePath = (relativePath) => `${basePath}/${relativePath.replace(/^\//, '')}`;
const sourceRoots = ['example-gallery/examples', 'example-gallery/runtime', 'example-gallery/support', 'skills'];
const vendorPackages = [
  'three', 'three-0180', 'three-0186', 'three-stdlib', 'postprocessing',
  'fflate', 'astronomy-engine', 'three-mesh-bvh', '@petamoriken/float16',
];
const rawExtensions = new Set(['.wgsl', '.glsl', '.frag', '.vert']);

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Browser URL references written for the dev server's origin must point to the
// repository subpath on project Pages. Relative asset URLs stay unchanged.
function prefixRootUrls(code) {
  return code.replace(/(["'`])\/(skills|example-gallery|node_modules|gallery|api)\//g,
    (_whole, quote, root) => `${quote}${basePath}/${root}/`);
}

function existingModule(filePath) {
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  for (const extension of ['.js', '.ts']) {
    if (existsSync(filePath + extension)) return filePath + extension;
  }
  for (const extension of ['index.js', 'index.ts']) {
    if (existsSync(path.join(filePath, extension))) return path.join(filePath, extension);
  }
  return null;
}

function rewriteSpecifier(specifier, sourcePath) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../') &&
      !specifier.startsWith('/skills/') && !specifier.startsWith('/example-gallery/')) {
    return specifier;
  }

  const [requestedFile, query] = specifier.split('?', 2);
  const absoluteFile = requestedFile.startsWith('/')
    ? path.join(projectRoot, requestedFile.slice(1))
    : path.resolve(path.dirname(sourcePath), requestedFile);
  let rewritten = requestedFile;

  if (query === 'raw') {
    if (!existsSync(absoluteFile) || !rawExtensions.has(path.extname(absoluteFile))) {
      throw new Error(`Unsupported raw module in ${sourcePath}: ${specifier}`);
    }
    rewritten = `${requestedFile}.js`;
  } else if (requestedFile.endsWith('.ts')) {
    rewritten = requestedFile.slice(0, -3) + '.js';
  } else if (!path.extname(requestedFile)) {
    const resolved = existingModule(absoluteFile);
    if (resolved?.endsWith('.ts') || resolved?.endsWith('.js')) {
      const suffix = resolved.endsWith('index.ts') || resolved.endsWith('index.js')
        ? '/index.js' : '.js';
      rewritten = requestedFile + suffix;
    }
  }
  return query && query !== 'raw' ? `${rewritten}?${query}` : rewritten;
}

function rewriteModuleImports(source, sourcePath) {
  const replace = (_match, prefix, quote, specifier) =>
    `${prefix}${quote}${rewriteSpecifier(specifier, sourcePath)}${quote}`;
  return source
    .replace(/(\bfrom\s+)(['"])([^'"\r\n]+)\2/g, replace)
    .replace(/(\bimport\s*(?:\(\s*)?)(['"])([^'"\r\n]+)\2/g, replace);
}

async function prepareCode(relativePath) {
  const sourcePath = path.join(projectRoot, relativePath);
  const outputPath = path.join(outputRoot, relativePath);
  const extension = path.extname(relativePath);

  if (relativePath.endsWith('.d.ts')) {
    await unlink(outputPath);
    return;
  }

  // AssemblyScript source for the separately compiled WASM solver; its
  // decorators are not JavaScript decorators and it is never a browser module.
  if (relativePath.endsWith('ocean-beach-waves/source/solver-kernels.ts')) return;

  if (rawExtensions.has(extension)) {
    const shaderSource = await readFile(sourcePath, 'utf8');
    await writeFile(`${outputPath}.js`, `export default ${JSON.stringify(shaderSource)};\n`);
    return;
  }

  if (extension !== '.js' && extension !== '.mjs' && extension !== '.ts') return;

  let code = await readFile(sourcePath, 'utf8');
  if (extension === '.ts') {
    try {
      const result = await transform(code, {
        loader: 'ts',
        format: 'esm',
        target: 'es2022',
        legalComments: 'none',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
      });
      code = result.code;
    } catch (error) {
      throw new Error(`Cannot transpile ${relativePath}: ${error.message}`, { cause: error });
    }
  }
  code = prefixRootUrls(rewriteModuleImports(code, sourcePath));
  if (extension === '.ts') {
    await writeFile(outputPath.slice(0, -3) + '.js', code);
    await unlink(outputPath);
  } else {
    await writeFile(outputPath, code);
  }
}

async function listFiles(folder, relativeFolder = '') {
  const paths = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = path.join(relativeFolder, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await listFiles(path.join(folder, entry.name), relative));
    } else if (entry.isFile()) {
      paths.push(relative.replaceAll('\\', '/'));
    }
  }
  return paths;
}

function previewFileName(example, ext) {
  return example.id.replace(/[^a-z0-9-]/gi, '_').toLowerCase() + ext;
}

function fallbackPreview(example) {
  const seed = [...example.id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7);
  const hue = 178 + seed % 145;
  const secondaryHue = (hue + 72) % 360;
  const title = escapeHtml(example.title.length > 37 ? example.title.slice(0, 35) + '…' : example.title);
  const backend = escapeHtml(example.backend.slice(0, 52));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#080b18"/><stop offset="1" stop-color="#101b2a"/></linearGradient>
<radialGradient id="a"><stop stop-color="hsl(${hue} 95% 62%)" stop-opacity=".6"/><stop offset="1" stop-color="hsl(${secondaryHue} 90% 35%)" stop-opacity="0"/></radialGradient></defs>
<rect width="960" height="540" fill="url(#bg)"/>
<circle cx="760" cy="100" r="350" fill="url(#a)"/>
<g fill="none" stroke="hsl(${hue} 85% 70%)" stroke-opacity=".4" stroke-width="1.3" transform="translate(710 220) rotate(-19)">
${Array.from({ length: 9 }, (_unused, i) => `<ellipse rx="${115 + i * 17}" ry="${22 + i * 13}"/>`).join('')}
</g><rect x="40" y="38" width="138" height="28" rx="14" fill="#ffffff" fill-opacity=".08"/>
<text x="58" y="57" fill="#d2f7ff" font-family="Arial,sans-serif" font-size="13" letter-spacing="1">LIVE SCENE</text>
<text x="42" y="417" fill="white" font-family="Arial,sans-serif" font-size="33" font-weight="bold">${title}</text>
<text x="44" y="452" fill="#bdcadc" font-family="Arial,sans-serif" font-size="17">${backend}</text>
<text x="44" y="499" fill="#8a9eb8" font-family="Arial,sans-serif" font-size="13" letter-spacing="2">CLICK TO OPEN INTERACTIVE PREVIEW</text>
</svg>\n`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const sourceRoot of sourceRoots) {
  await cp(path.join(projectRoot, sourceRoot), path.join(outputRoot, sourceRoot), { recursive: true });
}
for (const name of vendorPackages) {
  const vendorRoot = `node_modules/${name}`;
  await cp(path.join(projectRoot, vendorRoot), path.join(outputRoot, vendorRoot), { recursive: true });
}

let transformedFiles = 0;
for (const sourceRoot of sourceRoots) {
  for (const relative of await listFiles(path.join(projectRoot, sourceRoot))) {
    await prepareCode(`${sourceRoot}/${relative}`);
    transformedFiles += 1;
  }
}

// The same runtime shell serves normal, 0.180 and 0.186 Three.js examples.
const runtimeHtml = await readFile(path.join(projectRoot, 'example-gallery/runtime/index.html'), 'utf8');
for (const threePackage of [null, 'three-0180', 'three-0186']) {
  const filename = threePackage ? `${threePackage}.html` : 'index.html';
  const document = prefixRootUrls(inspectionRuntimeDocument(runtimeHtml, threePackage));
  await writeFile(path.join(outputRoot, 'example-gallery/runtime', filename), document);
}

const staticConfig = `<script>window.__GALLERY_STATIC__ = ${JSON.stringify({ basePath })};</script>`;
const galleryHtml = prefixRootUrls(
  (await readFile(path.join(projectRoot, 'example-gallery/public/index.html'), 'utf8'))
    .replace('<script type="module" src="/gallery/app.js"></script>',
      `${staticConfig}\n    <script type="module" src="/gallery/app.js"></script>`),
);
await mkdir(path.join(outputRoot, 'gallery'), { recursive: true });
await writeFile(path.join(outputRoot, 'index.html'), galleryHtml);
await writeFile(path.join(outputRoot, 'gallery/index.html'), galleryHtml);
for (const asset of ['app.js', 'styles.css']) {
  const source = path.join(projectRoot, 'example-gallery/public', asset);
  let contents = await readFile(source, 'utf8');
  if (asset.endsWith('.js')) contents = prefixRootUrls(contents);
  await writeFile(path.join(outputRoot, 'gallery', asset), contents);
}

const examples = await discoverExamples(projectRoot);
await mkdir(path.join(outputRoot, 'thumbnails'), { recursive: true });
const exportedExamples = [];
let capturedPreviews = 0;
for (const example of examples) {
  const modulePath = sitePath(`example-gallery/examples/${example.id}/scene.js`);
  const runtimeDocument = example.threePackage ?? 'index';
  const authoredPreview = path.join(projectRoot, 'example-gallery/previews', previewFileName(example, '.jpg'));
  const localPreview = path.join(projectRoot, '.pages-thumbnails', previewFileName(example, '.png'));
  const previewSource = existsSync(authoredPreview) ? authoredPreview : localPreview;
  const previewExtension = existsSync(authoredPreview) ? '.jpg' : existsSync(localPreview) ? '.png' : '.svg';
  const thumbnail = `thumbnails/${previewFileName(example, previewExtension)}`;
  const target = path.join(outputRoot, thumbnail);
  if (existsSync(previewSource)) {
    await copyFile(previewSource, target);
    capturedPreviews += 1;
  } else {
    await writeFile(target, fallbackPreview(example));
  }
  exportedExamples.push({
    ...example,
    entry: `${sitePath(`example-gallery/runtime/${runtimeDocument}.html`)}?module=${modulePath}`,
    source: sitePath(`example-gallery/examples/${example.id}/`),
    preview: example.preview ? sitePath(example.preview) : null,
    thumbnail: sitePath(thumbnail),
  });
}
await mkdir(path.join(outputRoot, 'api'), { recursive: true });
await writeFile(path.join(outputRoot, 'api/examples.json'),
  `${JSON.stringify({ count: exportedExamples.length, examples: exportedExamples }, null, 2)}\n`);
await writeFile(path.join(outputRoot, '.nojekyll'), '');
console.log(`Pages export: ${outputRoot}`);
console.log(`Base: ${basePath || '/'}; ${exportedExamples.length} interactive examples; ${capturedPreviews} captured thumbnails; ${transformedFiles} source files processed.`);
