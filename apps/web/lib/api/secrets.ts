import 'server-only';
import { z } from 'zod';
import { api } from './client';

/** Secret-store inventory (GET /v1/secrets): metadata only — values never leave the API. */
export const SecretSchema = z.object({
  ref: z.string(),
  name: z.string(),
  kind: z.string(),
  usedBy: z.string().nullable(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  version: z.number(),
  state: z.enum(['ok', 'expiring', 'expired']),
});
export type SecretMeta = z.infer<typeof SecretSchema>;

/** Customer-claims signing keys (GET /v1/security/signing-keys, system.configure). */
export const SigningKeySchema = z.object({ kid: z.string(), status: z.string(), createdAt: z.string(), retiringAt: z.string().nullable() });
export type SigningKey = z.infer<typeof SigningKeySchema>;

export const listSecrets = () => api.get('/v1/secrets', z.array(SecretSchema));
export const listSigningKeys = () => api.get('/v1/security/signing-keys', z.array(SigningKeySchema));
export const rotateSigningKey = () => api.post('/v1/security/signing-keys/rotate', undefined, z.object({ kid: z.string() }));
