#!/usr/bin/env node
/**
 * Smoke test of the static export (runs after `next build`, so every build and the Docker image check it).
 * Fails when the landing page loses its single h1, a call to action, alt text on an image, the robots/sitemap
 * files, or when copy claims the SDKs can already be installed from npm (they are "coming to npm").
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const problems = [];
const need = (ok, message) => {
  if (!ok) problems.push(message);
};

const read = (file) => {
  const path = join(out, file);
  need(existsSync(path), `${file} is missing from the export`);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

const html = read('index.html');
const h1s = html.match(/<h1[\s>]/g) ?? [];
need(h1s.length === 1, `index.html must have exactly one <h1> (found ${h1s.length})`);
const h1Text = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '').replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
need(h1Text === 'One Customer Success Orchestrator', `the h1 must read "One Customer Success Orchestrator" (found "${h1Text}")`);
need(/<main[\s>]/.test(html) && /<header[\s>]/.test(html) && /<footer[\s>]/.test(html), 'landmarks main, header and footer are required');

for (const [label, href] of [
  ['Try the demo', 'https://demo.ocso.winsenlabs.dev'],
  ['View on GitHub', 'https://github.com/winsenlabs/ocso'],
  ['Read the docs', 'https://github.com/winsenlabs/ocso/tree/main/docs'],
]) {
  const link = new RegExp(`<a[^>]*href="${href.replace(/[.]/g, '\\.')}"[^>]*>(?:(?!</a>)[\\s\\S])*${label}`);
  need(link.test(html), `call to action "${label}" → ${href} is missing`);
}

for (const img of html.match(/<img\b[^>]*>/g) ?? []) {
  need(/\balt="[^"]{12,}"/.test(img), `image without meaningful alt text: ${img.slice(0, 120)}`);
}
need(!/npm (?:install|i) @winsendotai/.test(html), 'the SDKs are not on npm yet: no install commands');
need(!/<script\b/.test(html), 'the page ships no JavaScript (scripts/strip-runtime.mjs)');
need(html.includes('Coming to npm'), 'the SDK cards must say "Coming to npm"');

need(/Sitemap: https?:\/\/\S+\/sitemap\.xml/.test(read('robots.txt')), 'robots.txt must point at the sitemap');
need(/<loc>https?:\/\/[^<]+\/<\/loc>/.test(read('sitemap.xml')), 'sitemap.xml must list the home page');
read('404.html');
read('opengraph-image.png');

if (problems.length) {
  console.error(`check-export: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('check-export: ok (one h1, three calls to action, alt text, robots.txt, sitemap.xml, 404)');
