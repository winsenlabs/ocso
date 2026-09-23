import { describe, expect, it } from 'vitest';
import { contributionLines, pluginCount } from '../../../lib/plugins';

const none = { channels: [], modelProviders: [], alertDestinations: [], emailDrivers: [] };

describe('plugins panel text', () => {
  it('lists each non-empty contribution, then internal ones', () => {
    expect(contributionLines({ contributes: { ...none, channels: ['ECHO', 'LINE'], emailDrivers: ['echo-mail'] }, internal: [] })).toEqual([
      'channels: ECHO, LINE',
      'email drivers: echo-mail',
    ]);
    expect(contributionLines({ contributes: none, internal: ['blob drivers: local, s3'] })).toEqual(['blob drivers: local, s3']);
    expect(contributionLines({ contributes: none, internal: [] })).toEqual(['nothing registered']);
  });

  it('counts first-party and installed plugins', () => {
    expect(pluginCount([{ source: 'first-party' }, { source: 'first-party' }, { source: 'installed' }])).toBe('2 first-party · 1 installed');
  });
});
