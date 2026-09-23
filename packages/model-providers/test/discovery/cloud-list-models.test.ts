import { describe, expect, it } from 'vitest';
import { isDomainError } from '@ocso/domain';
import { vertexHost, vertexModelId } from '../../src/discovery/vertex.js';
import { bedrockProvider } from '../../src/providers/bedrock/definition.js';
import { vertexProvider } from '../../src/providers/vertex/definition.js';
import { ACCESS_TOKEN, googleTokenEndpoint, SERVICE_ACCOUNT_JSON } from '../contract/fixtures/google-auth.js';
import { fakeFetch, jsonResponse, type Responder } from '../support/fake-fetch.js';
import { media, runtimeConfig } from '../support/requests.js';

const ACCESS_KEY = 'AKIAOCSOTEST00000001';
const SECRET_KEY = 'secret-SECRET-abcdefghijklmnopqrstuvwxyz0123';

/** Recorded shapes of ListFoundationModels / ListInferenceProfiles (research/09 §3). */
const FOUNDATION = {
  modelSummaries: [
    { modelId: 'amazon.nova-pro-v1:0', modelName: 'Nova Pro', providerName: 'Amazon', inputModalities: ['TEXT', 'IMAGE', 'VIDEO'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'ACTIVE' } },
    { modelId: 'anthropic.claude-opus-5', modelName: 'Claude Opus 5', providerName: 'Anthropic', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'ACTIVE' } },
    { modelId: 'meta.llama3-70b-instruct-v1:0', modelName: 'Llama 3 70B', providerName: 'Meta', inputModalities: ['TEXT'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'LEGACY' } },
    { modelId: 'amazon.titan-embed-text-v2:0', modelName: 'Titan Embeddings', providerName: 'Amazon', inputModalities: ['TEXT'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'] },
    { modelId: 'stability.sd3-large-v1:0', modelName: 'SD3', providerName: 'Stability', inputModalities: ['TEXT'], outputModalities: ['IMAGE'], inferenceTypesSupported: ['ON_DEMAND'] },
  ],
};
const profile = (id: string, model: string, type = 'SYSTEM_DEFINED') => ({
  inferenceProfileId: id,
  inferenceProfileArn: `arn:aws:bedrock:ap-south-1:123456789012:${type === 'APPLICATION' ? 'application-' : ''}inference-profile/${id}`,
  inferenceProfileName: `Profile ${id}`,
  createdAt: '2026-07-24T00:00:00Z',
  status: 'ACTIVE',
  type,
  models: [{ modelArn: `arn:aws:bedrock:ap-south-1::foundation-model/${model}` }],
});

function bedrock(settings: Record<string, unknown>, credentials: Record<string, string>, responder: Responder) {
  const f = fakeFetch(responder);
  const a = bedrockProvider.create(runtimeConfig('BEDROCK', settings, credentials, 'ap-south-1'), { media, fetch: f.fetch });
  return { adapter: a, calls: f.calls };
}

const bedrockResponder: Responder = (req) => {
  if (req.url.includes('/foundation-models')) return jsonResponse(FOUNDATION);
  if (req.url.includes('nextToken=page2')) return jsonResponse({ inferenceProfileSummaries: [profile('ocso-app', 'amazon.nova-pro-v1:0', 'APPLICATION')] });
  return jsonResponse({
    inferenceProfileSummaries: [profile('apac.anthropic.claude-opus-5', 'anthropic.claude-opus-5'), profile('apac.stability.sd3', 'stability.sd3-large-v1:0')],
    nextToken: 'page2',
  });
};

describe('Bedrock listModels', () => {
  it('SigV4-signs ListFoundationModels + ListInferenceProfiles on the control plane of the configured region', async () => {
    const h = bedrock({}, { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }, bedrockResponder);
    const models = await h.adapter.listModels!();
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://bedrock.ap-south-1.amazonaws.com/foundation-models?byOutputModality=TEXT',
      'https://bedrock.ap-south-1.amazonaws.com/inference-profiles?maxResults=1000',
      'https://bedrock.ap-south-1.amazonaws.com/inference-profiles?maxResults=1000&nextToken=page2',
    ]);
    const auth = h.calls[0]?.headers['authorization'] ?? '';
    expect(auth).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/\\d{8}/ap-south-1/bedrock/aws4_request`));
    expect(JSON.stringify(h.calls)).not.toContain(SECRET_KEY);
    expect(models.map((m) => [m.id, m.kind])).toEqual([
      ['amazon.nova-pro-v1:0', 'model'],
      ['meta.llama3-70b-instruct-v1:0', 'model'],
      ['apac.anthropic.claude-opus-5', 'inference-profile'],
      ['arn:aws:bedrock:ap-south-1:123456789012:application-inference-profile/ocso-app', 'inference-profile'],
    ]);
    expect(models[0]).toMatchObject({ displayName: 'Nova Pro', ownedBy: 'Amazon', input: ['text', 'image', 'video'], lifecycle: 'ACTIVE' });
    expect(models[1]).toMatchObject({ lifecycle: 'LEGACY' });
    expect(models[2]).toMatchObject({ baseModel: 'anthropic.claude-opus-5', input: ['text', 'image'], ownedBy: 'cross-region inference profile' });
  });

  it('API-key mode sends the key as a bearer token; region comes from settings first', async () => {
    const h = bedrock({ authMode: 'API_KEY', region: 'us-east-1' }, { apiKey: 'bedrock-api-key-SECRET' }, bedrockResponder);
    await h.adapter.listModels!();
    expect(h.calls[0]?.url).toBe('https://bedrock.us-east-1.amazonaws.com/foundation-models?byOutputModality=TEXT');
    expect(h.calls[0]?.headers['authorization']).toBe('Bearer bedrock-api-key-SECRET');
  });

  it('AccessDenied is a typed authorization error', async () => {
    const h = bedrock({}, { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }, () =>
      jsonResponse({ message: 'User is not authorized to perform: bedrock:ListFoundationModels' }, { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException:http://internal' } }),
    );
    const error = await h.adapter.listModels!().catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('provider_access_denied');
  });
});

/** Recorded shape of publishers.models.list (research/09 §4). */
const publisherPage = (publisher: string, items: Array<[string, string | undefined, string | undefined]>, next?: string) => ({
  publisherModels: items.map(([id, versionId, launchStage]) => ({
    name: `publishers/${publisher}/models/${id}`,
    ...(versionId ? { versionId } : {}),
    ...(launchStage ? { launchStage } : {}),
    openSourceCategory: 'PROPRIETARY',
  })),
  ...(next ? { nextPageToken: next } : {}),
});

describe('Vertex listModels', () => {
  it('lists Gemini and Claude publisher models with the service-account token and quota project', async () => {
    const f = fakeFetch((req) => {
      const token = googleTokenEndpoint(req);
      if (token) return token;
      if (req.url.includes('/publishers/google/') && !req.url.includes('pageToken')) {
        return jsonResponse(publisherPage('google', [['gemini-3.5-flash', '001', 'GA'], ['gemini-embedding-001', '001', 'GA'], ['imagen-4.0-generate-001', '001', 'GA']], 'p2'));
      }
      if (req.url.includes('/publishers/google/')) return jsonResponse(publisherPage('google', [['gemini-2.5-pro', 'default', 'DEPRECATED'], ['gemini-2.5-flash-tts', '001', 'GA']]));
      return jsonResponse(publisherPage('anthropic', [['claude-opus-5', 'default', 'GA'], ['claude-haiku-4-5', '20251001', 'GA']]));
    });
    const a = vertexProvider.create(runtimeConfig('VERTEX', { location: 'asia-south1' }, { serviceAccountJson: SERVICE_ACCOUNT_JSON }), { media, fetch: f.fetch });
    const models = await a.listModels!();
    const listCalls = f.calls.filter((c) => c.url.includes('aiplatform'));
    expect(listCalls.map((c) => c.url)).toEqual([
      'https://asia-south1-aiplatform.googleapis.com/v1/publishers/google/models?pageSize=100',
      'https://asia-south1-aiplatform.googleapis.com/v1/publishers/google/models?pageSize=100&pageToken=p2',
      'https://asia-south1-aiplatform.googleapis.com/v1/publishers/anthropic/models?pageSize=100',
    ]);
    expect(listCalls[0]?.headers).toMatchObject({ authorization: `Bearer ${ACCESS_TOKEN}`, 'x-goog-user-project': 'ocso-test' });
    expect(models.map((m) => [m.id, m.lifecycle])).toEqual([
      ['gemini-3.5-flash', 'ACTIVE'],
      ['gemini-2.5-pro', 'DEPRECATED'],
      ['claude-opus-5', 'ACTIVE'],
      ['claude-haiku-4-5@20251001', 'ACTIVE'],
    ]);
  });

  it('host and id rules', () => {
    expect(vertexHost('global')).toBe('https://aiplatform.googleapis.com');
    expect(vertexHost('eu')).toBe('https://aiplatform.googleapis.com');
    expect(vertexHost('us-central1')).toBe('https://us-central1-aiplatform.googleapis.com');
    expect(vertexModelId('anthropic', { name: 'publishers/anthropic/models/claude-sonnet-4-5', versionId: '20250929' })).toBe('claude-sonnet-4-5@20250929');
    expect(vertexModelId('google', { name: 'publishers/google/models/gemini-3.5-flash', versionId: '001' })).toBe('gemini-3.5-flash');
  });
});
