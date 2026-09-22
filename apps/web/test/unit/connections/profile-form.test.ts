import { describe, expect, it } from 'vitest';
import { initialProfileForm, moveTarget, toProfileInput } from '../../../components/connections/models/profile-form';

const P1 = '0192f0c1-0000-7000-8000-000000000001';
const P2 = '0192f0c1-0000-7000-8000-000000000002';

describe('profile form ↔ API input', () => {
  it('uses the API defaults for a new profile', () => {
    const state = { ...initialProfileForm(null, P1), name: 'support-primary', model: 'claude-sonnet-4-5' };
    const r = toProfileInput(state);
    expect(r).toEqual({
      ok: true,
      input: expect.objectContaining({ name: 'support-primary', providerId: P1, maxOutputTokens: 1024, timeoutMs: 30_000, retries: 1, retryBackoffMs: 400, cachePolicy: 'PREFIX', cacheTtl: null, temperature: null, reasoning: null, fallbacks: [], requiredCapabilities: {} }),
    });
  });

  it('round-trips an existing profile, keeping fallback order and only required capabilities', () => {
    const state = initialProfileForm(
      {
        name: 'sales-primary',
        description: 'Arjun',
        providerId: P1,
        model: 'gemini-2.5-pro',
        fallbacks: [{ providerId: P2, providerName: 'B', providerKind: 'BEDROCK', model: 'claude' }],
        temperature: 0.2,
        maxOutputTokens: 800,
        reasoning: 'low',
        timeoutMs: 45_000,
        retries: 2,
        retryBackoffMs: 250,
        cachePolicy: 'PREFIX',
        cacheTtl: '1h',
        requiredCapabilities: { imageInput: true },
      },
      P2,
    );
    state.capabilities = { ...state.capabilities, audioInput: false };
    const r = toProfileInput(state);
    expect(r.ok && r.input).toMatchObject({ temperature: 0.2, timeoutMs: 45_000, cacheTtl: '1h', reasoning: 'low', fallbacks: [{ providerId: P2, model: 'claude' }], requiredCapabilities: { imageInput: true } });
  });

  it('reports field errors: name, ranges, incomplete and duplicate fallbacks', () => {
    const base = { ...initialProfileForm(null, P1), name: 'Support Primary', model: 'm', temperature: '3', retries: '1.5' };
    const r = toProfileInput(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['name', 'retries', 'temperature']);
    const dup = toProfileInput({ ...initialProfileForm(null, P1), name: 'ok-name', model: 'm', fallbacks: [{ key: 'a', providerId: P1, model: 'm' }] });
    expect(!dup.ok && dup.errors['fallbacks']).toContain('more than once');
    const empty = toProfileInput({ ...initialProfileForm(null, P1), name: 'ok-name', model: 'm', fallbacks: [{ key: 'a', providerId: P2, model: ' ' }] });
    expect(!empty.ok && empty.errors['fallbacks']).toContain('needs a provider and a model');
  });

  it('reorders fallbacks', () => {
    const rows = [{ key: 'a', providerId: P1, model: '1' }, { key: 'b', providerId: P2, model: '2' }];
    expect(moveTarget(rows, 1, -1).map((r) => r.key)).toEqual(['b', 'a']);
    expect(moveTarget(rows, 0, -1).map((r) => r.key)).toEqual(['a', 'b']);
  });
});
