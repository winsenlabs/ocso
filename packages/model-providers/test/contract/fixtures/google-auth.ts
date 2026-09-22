import { generateKeyPairSync } from 'node:crypto';
import { jsonResponse, type CapturedRequest } from '../../support/fake-fetch.js';

/** A throwaway service-account key (fresh RSA key per test run) and a fake OAuth token endpoint. */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const SA_PRIVATE_KEY = privateKey;
export const SA_PRIVATE_KEY_ID = 'key-id-SECRET-0123456789abcdef';
export const ACCESS_TOKEN = 'ya29.ocso-test-access-token-SECRET';

export const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'ocso-test',
  private_key_id: SA_PRIVATE_KEY_ID,
  private_key: SA_PRIVATE_KEY,
  client_email: 'ocso-runtime@ocso-test.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

/** Answers the JWT-bearer token exchange; everything else is a model call. */
export function googleTokenEndpoint(req: CapturedRequest): Response | undefined {
  if (req.url !== 'https://oauth2.googleapis.com/token') return undefined;
  const form = new URLSearchParams(String(req.body));
  if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !form.get('assertion')) {
    return jsonResponse({ error: 'invalid_grant' }, { status: 400 });
  }
  return jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' });
}
