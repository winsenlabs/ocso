/**
 * Content sniffing by magic numbers. Declared MIME types from channels and
 * browsers are hints; stored media must match what the bytes actually are.
 */
interface Signature {
  mime: string;
  offset: number;
  bytes: number[];
}

const SIGNATURES: readonly Signature[] = [
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: 'audio/ogg', offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'audio/amr', offset: 0, bytes: [0x23, 0x21, 0x41, 0x4d, 0x52] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mime: 'application/zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
];

function matches(data: Uint8Array, sig: Signature): boolean {
  if (data.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => data[sig.offset + i] === b);
}

function ascii(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end));
}

/** Best-effort detection; returns null when unknown. */
export function sniffMime(data: Uint8Array): string | null {
  for (const sig of SIGNATURES) if (matches(data, sig)) return sig.mime;
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && ascii(data, 4, 8) === 'ftyp') {
    const brand = ascii(data, 8, 12);
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand.startsWith('3gp')) return 'video/3gpp';
    return 'video/mp4';
  }
  if (data.length >= 2 && data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/** OOXML documents are zip containers; checkMedia keeps the declared type for them. */
const OFFICE_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export interface MediaCheck {
  ok: boolean;
  mimeType: string;
  reason?: string | undefined;
}

/**
 * Accept media when the sniffed type is allowed and consistent with the declared
 * type. Plain-text types cannot be sniffed and are accepted on declaration.
 */
export function checkMedia(
  data: Uint8Array,
  declared: string,
  allowed: readonly string[],
  maxBytes: number,
): MediaCheck {
  const declaredBase = declared.split(';')[0]!.trim().toLowerCase();
  if (data.length > maxBytes) return { ok: false, mimeType: declaredBase, reason: 'too_large' };
  if (data.length === 0) return { ok: false, mimeType: declaredBase, reason: 'empty' };
  const sniffed = sniffMime(data);
  let effective = sniffed ?? declaredBase;
  if (sniffed === 'application/zip' && OFFICE_TYPES.has(declaredBase)) effective = declaredBase;
  if (!sniffed && !declaredBase.startsWith('text/')) {
    return { ok: false, mimeType: declaredBase, reason: 'unrecognized_content' };
  }
  if (!allowed.includes(effective)) return { ok: false, mimeType: effective, reason: 'type_not_allowed' };
  return { ok: true, mimeType: effective };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
};

export function extensionFor(mime: string): string {
  return EXTENSIONS[mime] ?? 'bin';
}
