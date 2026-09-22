import type { AmazonBedrockProviderSettings } from '@ai-sdk/amazon-bedrock';
import { validation } from '@ocso/domain';
import { acquireCredential } from '../shared/sdk-helpers.js';

export type BedrockAuthMode = 'ACCESS_KEYS' | 'IAM_ROLE' | 'API_KEY';

export interface BedrockCredentials {
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  sessionToken?: string | undefined;
  apiKey?: string | undefined;
}

type AwsCredentialProvider = () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;

/**
 * IAM role mode (ECS task role, EC2 instance profile, IRSA, SSO/env): the AWS
 * default Node credential chain, loaded lazily so deployments using access
 * keys never import it. `fromNodeProviderChain` memoizes and refreshes.
 */
function roleCredentialProvider(): NonNullable<AmazonBedrockProviderSettings['credentialProvider']> {
  let chain: Promise<AwsCredentialProvider> | undefined;
  return () =>
    acquireCredential('AWS role credentials', async () => {
      chain ??= import('@aws-sdk/credential-providers').then((m) => m.fromNodeProviderChain());
      const c = await (await chain)();
      return c.sessionToken
        ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken }
        : { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    });
}

/**
 * Auth portion of `createAmazonBedrock` options for the configured mode.
 * `apiKey: ''` pins SigV4: without it an ambient AWS_BEARER_TOKEN_BEDROCK
 * environment variable would silently override the configured credentials.
 */
export function bedrockAuthOptions(
  mode: BedrockAuthMode,
  creds: BedrockCredentials,
): Pick<AmazonBedrockProviderSettings, 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'apiKey' | 'credentialProvider'> {
  if (mode === 'IAM_ROLE') return { apiKey: '', credentialProvider: roleCredentialProvider() };
  if (mode === 'API_KEY') {
    if (!creds.apiKey) throw validation('provider_credentials_invalid', 'A Bedrock API key is required', { fields: ['apiKey'] });
    return { apiKey: creds.apiKey };
  }
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw validation('provider_credentials_invalid', 'An AWS access key id and secret access key are required', {
      fields: ['accessKeyId', 'secretAccessKey'],
    });
  }
  return {
    apiKey: '',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
}
