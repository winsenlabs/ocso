import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOPICS } from '../src/contract.js';

describe('AWS Terraform queues', () => {
  it('creates an SQS queue for every topic the code publishes', () => {
    const tf = readFileSync(fileURLToPath(new URL('../../../infra/aws/terraform/variables-operations.tf', import.meta.url)), 'utf8');
    const block = /variable "queue_topics" \{[\s\S]*?default = \[([\s\S]*?)\]/.exec(tf)?.[1] ?? '';
    const topics = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(topics.sort()).toEqual(Object.values(TOPICS).sort());
  });
});
