#!/usr/bin/env node
/**
 * Smoke test of the built site (runs after `next build`, so every build and the Docker image check it).
 * Fails when the landing page loses its single h1, one of its two calls to action or alt text on an image,
 * when copy claims the SDKs can already be installed from npm (they are "coming to npm"), when the product
 * name drifts, or when the demo form and the D1 migration disagree about the columns.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const need = (ok, message) => ok || problems.push(message);

const page = join(root, '.next/server/app/index.html');
need(existsSync(page), '.next/server/app/index.html is missing: run next build first');
const html = existsSync(page) ? readFileSync(page, 'utf8') : '';
const text = html.replace(/<script[\s\S]*?<\/script>/g, '');

need((text.match(/<h1[\s>]/g) ?? []).length === 1, 'the page must have exactly one <h1>');
need(text.includes('Open Customer Success Orchestration'), 'the name "Open Customer Success Orchestration" must appear');
need(!/One Customer Success Orchestrator/.test(html), 'the old name "One Customer Success Orchestrator" must not appear');
need(/<a[^>]*href="#demo"[^>]*>(?:(?!<\/a>)[\s\S])*Request a demo/.test(text), 'call to action "Request a demo" → #demo is missing');
need(/<a[^>]*href="https:\/\/github\.com\/winsenlabs\/ocso"[^>]*>(?:(?!<\/a>)[\s\S])*View on GitHub/.test(text), 'call to action "View on GitHub" is missing');
need(/href="https:\/\/winsenlabs\.com"/.test(text), 'the link to https://winsenlabs.com is missing');
need(!/demo\.ocso\.winsenlabs\.dev/.test(html), 'there is no self-serve demo: no link to demo.ocso.winsenlabs.dev');
need(/id="demo"/.test(text), 'the #demo form section is missing');
for (const img of text.match(/<img\b[^>]*>/g) ?? []) {
  need(/\balt=""[^>]*aria-hidden|aria-hidden[^>]*\balt=""|\balt="[^"]{12,}"/.test(img), `image without meaningful alt text: ${img.slice(0, 120)}`);
}
need(!/npm (?:install|i) @winsendotai/.test(html), 'the SDKs are not on npm yet: no install commands');
need(html.includes('Coming to npm'), 'the SDK cards must say "Coming to npm"');
need(!existsSync(join(root, 'public/shots/ask-ocso.webp')), 'ask-ocso.webp (an edited capture) must not ship');
need(!existsSync(join(root, 'public/shots/webchat.webp')), 'webchat.webp (scripted-model tool output in a reply) must not ship');
need(text.includes('Screens from OCSO running with demo data.'), 'the showcase note "Screens from OCSO running with demo data." is missing');
need(/Today customer success is scattered across channels, tools and teams, with AI bolted on at the edges\./.test(text), 'the hero lede\'s first sentence changed');

// Product screenshots: every file in public/shots is used, every <img> of one has real alt text, sizes, and
// lazy loading (they are all below the fold).
const shotFiles = readdirSync(join(root, 'public/shots')).filter((f) => f.endsWith('.webp'));
const shotImgs = (text.match(/<img\b[^>]*src="\/shots\/[^"]+"[^>]*>/g) ?? []);
need(shotFiles.length >= 15, `expected at least 15 product screenshots in public/shots (found ${shotFiles.length})`);
for (const f of shotFiles) need(text.includes(`/shots/${f}`), `public/shots/${f} is not used on the page`);
for (const img of shotImgs) {
  need(/\balt="[^"]{60,}"/.test(img), `screenshot alt text is too short to describe it: ${img.slice(0, 100)}`);
  need(/\bwidth="\d+"/.test(img) && /\bheight="\d+"/.test(img), `screenshot without width and height: ${img.slice(0, 100)}`);
  need(/\bloading="lazy"/.test(img), `screenshot below the fold must be lazy-loaded: ${img.slice(0, 100)}`);
}
for (const f of shotFiles) {
  const kb = readFileSync(join(root, 'public/shots', f)).length / 1024;
  need(kb <= 200, `public/shots/${f} is ${Math.round(kb)} KB: keep screenshots under 200 KB`);
}

// Every form field is a column of site_demo_requests, and appears in exactly one step.
const { demoForm, allFields } = await import(join(root, 'content/forms.ts'));
const sql = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(root, 'migrations', f), 'utf8'))
  .join('\n');
const names = allFields(demoForm).map((f) => f.name);
need(new Set(names).size === names.length, 'a form field appears in more than one step');
need(demoForm.steps.length === 3, 'the form has three steps (three desktop columns, three mobile steps)');
for (const n of names) need(new RegExp(`^\\s+${n}\\s+TEXT`, 'm').test(sql), `form field "${n}" has no column in migrations/`);

if (problems.length) {
  console.error(`check-site: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-site: ok (one h1, two calls to action, ${shotFiles.length} screenshots used with alt text, ${names.length} form fields match the D1 table)`);
