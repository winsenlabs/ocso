'use client';

import { useState } from 'react';

export interface StagedAttachment {
  id: string;
  filename: string;
  partType: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';
  media: Record<string, unknown>;
}

/** Uploads staff reply attachments through the BFF route; the API decides what the channel accepts. */
export function useAttachments(conversationId: string) {
  const [items, setItems] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const res = await fetch(`/api/conversations/${conversationId}/attachments`, {
          method: 'POST',
          body: file,
          headers: {
            'content-type': file.type || 'application/octet-stream',
            ...(file.type ? {} : { 'x-ocso-content-type': 'application/octet-stream' }),
            'x-ocso-filename': encodeURIComponent(file.name.slice(0, 120)),
          },
        });
        const body = (await res.json().catch(() => null)) as { partType?: StagedAttachment['partType']; media?: Record<string, unknown>; error?: { message?: string } } | null;
        if (!res.ok || !body?.partType || !body.media) throw new Error(body?.error?.message ?? `Could not attach ${file.name}`);
        setItems((cur) => [...cur, { id: String(body.media!['blobKey']), filename: file.name, partType: body.partType!, media: body.media! }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not attach ${file.name}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  return {
    items,
    uploading: uploading > 0,
    error,
    add,
    remove: (id: string) => setItems((cur) => cur.filter((a) => a.id !== id)),
    clear: () => setItems([]),
  };
}
