import { DomainError, ErrorCategory, isDomainError, type MediaResolver, type ModelMessage } from '@ocso/domain';

export interface ResolvedMedia {
  data: Uint8Array;
  mimeType: string;
}

/**
 * Resolve every media part to bytes inside the adapter (trusted code), once
 * per blob key and concurrently. Blob keys never reach the provider.
 */
export async function resolveMedia(
  messages: readonly ModelMessage[],
  resolver: MediaResolver,
): Promise<ReadonlyMap<string, ResolvedMedia>> {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'image' || part.type === 'file') keys.add(part.blobKey);
    }
  }
  const entries = await Promise.all(
    [...keys].map(async (blobKey): Promise<[string, ResolvedMedia]> => {
      try {
        const resolved = await resolver.resolve(blobKey);
        return [blobKey, resolved];
      } catch (error) {
        if (isDomainError(error)) throw error;
        throw new DomainError(ErrorCategory.INTERNAL, 'media_resolution_failed', 'A media attachment could not be loaded', {
          blobKey,
        });
      }
    }),
  );
  return new Map(entries);
}
