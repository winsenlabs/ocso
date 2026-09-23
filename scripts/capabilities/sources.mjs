/**
 * Static pass of the capability extractor (PM/research/12 §3): the TypeScript
 * compiler API (typescript/unstable/sync, TS 7) reads each controller handler's
 * doc comment and the approval descriptor kinds it names; the web app's page
 * tree gives the pages `ui.open_page` may link to.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function listFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

/** Plain text of a `/** … *\/` block: no stars, no tags, paragraphs kept as single lines. */
function cleanDoc(raw) {
  const body = raw
    .trim()
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd());
  const text = [];
  for (const line of body) {
    if (/^@\w+/.test(line.trim())) break;
    text.push(line);
  }
  return text
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Per controller class: its module (directory under apps/api/src/modules), file, and per handler the
 * doc comment and the approval kinds the handler names (string-literal types of `objectKind:` / `kind:`).
 */
export async function readSources(REPO_ROOT, API_ROOT, MODULES_DIR) {
  const { API } = await import('typescript/unstable/sync');
  const { SyntaxKind } = await import('typescript/unstable/ast');
  const files = listFiles(MODULES_DIR, (f) => f.endsWith('.controller.ts'));
  const api = new API({ cwd: REPO_ROOT });
  const classes = new Map();
  try {
    const snapshot = api.updateSnapshot({ openProjects: [join(API_ROOT, 'tsconfig.json')] });
    const project = snapshot.getProject(join(API_ROOT, 'tsconfig.json')) ?? snapshot.getProjects()[0];
    if (!project) throw new Error('capabilities: could not open apps/api/tsconfig.json');
    const { checker, program } = project;
    for (const file of files) {
      const sf = program.getSourceFile(file);
      if (!sf) throw new Error(`capabilities: ${file} is not in the API program`);
      const module = relative(MODULES_DIR, file).split(sep)[0];
      const docOf = (node) => {
        const docs = node.jsDoc ?? [];
        const last = docs[docs.length - 1];
        return last ? cleanDoc(sf.text.slice(last.pos, last.end)) || undefined : undefined;
      };
      for (const statement of sf.statements) {
        if (statement.kind !== SyntaxKind.ClassDeclaration || !statement.name) continue;
        const methods = new Map();
        for (const member of statement.members) {
          if (member.kind !== SyntaxKind.MethodDeclaration || !member.name) continue;
          const found = [];
          const visit = (n) => {
            if ((n.kind === SyntaxKind.PropertyAssignment || n.kind === SyntaxKind.ShorthandPropertyAssignment) && (n.name?.text === 'objectKind' || n.name?.text === 'kind')) {
              found.push(n.kind === SyntaxKind.PropertyAssignment ? n.initializer : n.name);
            }
            n.forEachChild(visit);
          };
          member.body?.forEachChild(visit);
          const kinds = new Set();
          for (const node of found) {
            const type = checker.getTypeAtLocation(node);
            if (type?.isStringLiteralType?.()) kinds.add(type.value);
          }
          // `this.helper(…)` calls: a private helper often names the approval kind for several routes.
          const calls = new Set();
          const visitCalls = (n) => {
            if (n.kind === SyntaxKind.CallExpression && n.expression?.kind === SyntaxKind.PropertyAccessExpression && n.expression.expression?.kind === SyntaxKind.ThisKeyword) calls.add(n.expression.name.text);
            n.forEachChild(visitCalls);
          };
          member.body?.forEachChild(visitCalls);
          methods.set(member.name.text, { doc: docOf(member), kinds: [...kinds], calls: [...calls] });
        }
        for (const meta of methods.values()) {
          const seen = new Set();
          const queue = [...meta.calls];
          while (queue.length) {
            const callee = methods.get(queue.shift());
            if (!callee || seen.has(callee)) continue;
            seen.add(callee);
            for (const k of callee.kinds) if (!meta.kinds.includes(k)) meta.kinds.push(k);
            queue.push(...callee.calls);
          }
        }
        classes.set(statement.name.text, { module, file: relative(REPO_ROOT, file), doc: docOf(statement), methods });
      }
    }
  } finally {
    api.close();
  }
  return classes;
}

/** Signed-in web pages (`apps/web/app/(app)/…/page.tsx`) as `/agents/:id` patterns: what `ui.open_page` may link to. */
export function appRoutes(WEB_APP_DIR) {
  const appDir = join(WEB_APP_DIR, '(app)');
  const pages = listFiles(appDir, (f) => /\/page\.tsx$/.test(f));
  return pages
    .map((f) => {
      const rel = relative(appDir, f).split(sep).slice(0, -1);
      const segs = rel.filter((s) => !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[(\w+)\]$/, ':$1'));
      return `/${segs.join('/')}`;
    })
    .sort();
}
