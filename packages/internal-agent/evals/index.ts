/**
 * Ask OCSO evaluations (PM/research/12 §10): scenarios as data, the runner and the scoring. The API test
 * support seeds the world and runs them (apps/api/test/int/ask-ocso-evals.int.test.ts); see README.md.
 */
export * from './types.js';
export * from './world.js';
export * from './refs.js';
export * from './score.js';
export * from './report.js';
export * from './runner.js';
export { SCENARIOS, HEAD_SCENARIOS, LEAD_SCENARIOS, SERVICE_SCENARIOS, TECH_SCENARIOS } from './scenarios/index.js';
