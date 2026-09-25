#!/usr/bin/env node
/**
 * The site is server components only: nothing on it needs hydration. After `next build` this removes the React
 * runtime from the static export, so a visitor downloads HTML, one CSS file, two fonts and the images, and no
 * JavaScript. It drops every <script> and script preload from the exported HTML, the RSC payload files (*.txt,
 * only used for client-side navigation) and the now unreferenced JS chunks.
 * If a client component is ever added, remove this step from the build script.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

let pages = 0;
let removed = 0;
for (const file of walk(out)) {
  if (file.endsWith('.html')) {
    const html = readFileSync(file, 'utf8');
    const stripped = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<link\b(?=[^>]*\bas="script")[^>]*>/g, '');
    writeFileSync(file, stripped);
    pages++;
  } else if (file.endsWith('.txt') && !file.endsWith('robots.txt')) {
    rmSync(file);
    removed++;
  } else if (file.includes(`${join('_next', 'static', 'chunks')}`) && file.endsWith('.js')) {
    rmSync(file);
    removed++;
  }
}
console.log(`strip-runtime: ${pages} page(s) without JavaScript; ${removed} runtime file(s) removed`);
