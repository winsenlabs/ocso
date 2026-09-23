#!/usr/bin/env node
// `pnpm evals:ask-ocso --profile <model profile id | replay>`: run the Ask OCSO evaluation suite
// (packages/internal-agent/evals, README.md) against a throwaway OCSO on the local Postgres.
//
//   --profile <uuid>   a model profile of the deployment in --source-db (default: OCSO_EVAL_SOURCE_DATABASE_URL,
//                      else DATABASE_URL from the environment or the repo's .env). Its provider's credentials are
//                      read through that deployment's secret store (its OCSO_SECRETS_MASTER_KEY / SECRETS_* env).
//   --profile replay   the scripted replay CI runs, with a report (checks the plumbing, no model).
//   --only <ids>       comma-separated scenario ids or prefixes (e.g. `tech.,head.checker-approve`).
//   --out <dir>        where the Markdown + JSON report goes (default packages/internal-agent/evals/results).
//   --no-gate          report only: do not fail below the targets (100% safety, >= 90% task success).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

function usage(problem) {
  if (problem) console.error(`evals:ask-ocso: ${problem}`);
  console.error('usage: pnpm evals:ask-ocso --profile <model profile id | replay> [--only <ids>] [--source-db <url>] [--out <dir>] [--no-gate]');
  process.exit(2);
}

const args = { profile: '', only: '', sourceDb: '', out: join(here, 'results'), gate: true };
const argv = process.argv.slice(2).filter((a) => a !== '--');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => argv[++i] ?? usage(`${a} needs a value`);
  if (a === '--profile') args.profile = value();
  else if (a === '--only') args.only = value();
  else if (a === '--source-db') args.sourceDb = value();
  else if (a === '--out') args.out = resolve(value());
  else if (a === '--no-gate') args.gate = false;
  else if (a === '--help' || a === '-h') usage();
  else usage(`unknown argument ${a}`);
}
if (!args.profile) usage('--profile is required');
if (args.profile !== 'replay' && !/^[0-9a-f-]{36}$/i.test(args.profile)) usage('--profile must be a model profile id (uuid) or "replay"');

// The deployment's own settings (DATABASE_URL, secrets key) for reading the profile; never overrides the shell.
const dotenv = join(repo, '.env');
if (args.profile !== 'replay' && existsSync(dotenv)) process.loadEnvFile(dotenv);
const source = args.sourceDb || process.env.OCSO_EVAL_SOURCE_DATABASE_URL || process.env.DATABASE_URL || '';
if (args.profile !== 'replay' && !source) usage('no deployment database: pass --source-db or set DATABASE_URL');

const vitest = join(repo, 'node_modules/.bin/vitest');
const env = {
  ...process.env,
  ASK_OCSO_EVAL_PROFILE: args.profile,
  ASK_OCSO_EVAL_OUT: args.out,
  ...(args.only ? { ASK_OCSO_EVAL_ONLY: args.only } : {}),
  ...(args.gate ? {} : { ASK_OCSO_EVAL_NO_GATE: '1' }),
  ...(source ? { OCSO_EVAL_SOURCE_DATABASE_URL: source } : {}),
};
const run = spawnSync(vitest, ['run', '--project', 'integration', 'apps/api/test/int/ask-ocso-evals.int.test.ts'], { cwd: repo, env, stdio: 'inherit' });
process.exit(run.status ?? 1);
