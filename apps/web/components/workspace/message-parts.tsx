'use client';

import { useState, type ReactNode } from 'react';
import { isTemplateMessageSchema } from '@ocso/domain';
import { Modal } from '@/components/ui/modal';
import type { MessagePart } from '@/lib/api/conversations';
import { fileBadge, formatBytes } from './lib/timeline';

type Media = { mimeType: string; sizeBytes?: number | undefined; filename?: string | undefined; status: string; rejectionReason?: string | undefined };
type Known = Extract<MessagePart, { type: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | 'CONTACT' | 'STRUCTURED' | 'TOOL_RESULT' }>;

const KNOWN = new Set(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'CONTACT', 'STRUCTURED', 'TOOL_RESULT']);
const isKnown = (p: MessagePart): p is Known => KNOWN.has(p.type) && ('text' in p || 'media' in p || 'latitude' in p || 'contacts' in p || 'schema' in p || 'toolName' in p);

/**
 * Canonical multimodal parts (docs/archive/specs/07 §1) as the workspace shows them. Media
 * comes from short-lived signed URLs the timeline API attaches — never raw
 * blob keys. Media that is not stored yet (or was rejected) says so.
 */
export function MessageParts({ parts }: { parts: MessagePart[] }) {
  const [zoom, setZoom] = useState<{ url: string; title: string; sub: string } | null>(null);
  return (
    <span className="parts">
      {parts.map((part, i) => (
        <Part key={i} part={part} onZoom={setZoom} />
      ))}
      {zoom ? (
        <Modal title={zoom.title} sub={zoom.sub} onClose={() => setZoom(null)} maxWidth={960}>
          <img className="lightbox-img" src={zoom.url} alt={zoom.title} />
        </Modal>
      ) : null}
    </span>
  );
}

function Part({ part, onZoom }: { part: MessagePart; onZoom: (z: { url: string; title: string; sub: string }) => void }) {
  if (!isKnown(part)) return <span className="mono-sm">[{part.type.toLowerCase()} part]</span>;
  switch (part.type) {
    case 'TEXT':
      return (
        <span>
          {part.text.split(/\n{2,}/).map((para, i) => (
            <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
              {para}
            </p>
          ))}
        </span>
      );
    case 'IMAGE': {
      const title = part.media.filename ?? 'image';
      if (!part.url || part.media.status !== 'STORED') return <Attachment media={part.media} kind="image part" />;
      const url = part.url;
      return (
        <span>
          <button type="button" className="media-img" onClick={() => onZoom({ url, title, sub: meta(part.media, 'image part') })} aria-label={`Open image ${title}`}>
            <img src={url} alt={part.caption ?? title} loading="lazy" />
          </button>
          {part.caption ? <span className="caption">{part.caption}</span> : null}
        </span>
      );
    }
    case 'DOCUMENT':
      return (
        <span>
          <Attachment media={part.media} kind="document part" url={part.url} />
          {part.caption ? <span className="caption">{part.caption}</span> : null}
        </span>
      );
    case 'AUDIO':
      return (
        <span>
          {part.url && part.media.status === 'STORED' ? <audio controls preload="none" src={part.url} /> : <Attachment media={part.media} kind={part.voiceNote ? 'voice note' : 'audio part'} />}
          {part.transcript ? <span className="caption mono-sm">transcript · {part.transcript}</span> : null}
        </span>
      );
    case 'VIDEO':
      return (
        <span>
          {part.url && part.media.status === 'STORED' ? <video controls preload="metadata" src={part.url} /> : <Attachment media={part.media} kind="video part" />}
          {part.caption ? <span className="caption">{part.caption}</span> : null}
        </span>
      );
    case 'LOCATION': {
      const coords = `${part.latitude.toFixed(5)}, ${part.longitude.toFixed(5)}`;
      const map = `https://www.openstreetmap.org/?mlat=${part.latitude}&mlon=${part.longitude}#map=16/${part.latitude}/${part.longitude}`;
      return (
        <a className="att" href={map} target="_blank" rel="noopener noreferrer">
          <span className="thumb">LOC</span>
          <span>
            <b>{part.name ?? 'Shared location'}</b>
            <br />
            <span className="mono-sm">{[part.address, coords].filter(Boolean).join(' · ')}</span>
          </span>
        </a>
      );
    }
    case 'CONTACT':
      return (
        <span className="att">
          <span className="thumb">VCF</span>
          <span>
            {part.contacts.map((c, i) => (
              <span key={i} style={{ display: 'block' }}>
                <b>{c.name}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {[c.organization, ...c.phones, ...c.emails].filter(Boolean).join(' · ') || 'contact card'}
                </span>
              </span>
            ))}
          </span>
        </span>
      );
    case 'STRUCTURED':
      if (isTemplateMessageSchema(part.schema)) return <TemplateMessage text={part.fallbackText ?? ''} data={part.data} />;
      return part.fallbackText ? <p>{part.fallbackText}</p> : <span className="mono-sm">[{part.schema}]</span>;
    case 'TOOL_RESULT':
      return (
        <span className="mono-sm">
          tool {part.toolName} · {part.status.toLowerCase()}
        </span>
      );
  }
}

/** A sent message template: the exact text the customer received, and which template it was. */
function TemplateMessage({ text, data }: { text: string; data: Record<string, unknown> }) {
  const facts = [data['name'], data['language'], typeof data['category'] === 'string' ? data['category'].toLowerCase() : null].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return (
    <span className="tplmsg">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
          {para}
        </p>
      ))}
      <span className="mono-sm tpltag">message template · {facts.join(' · ')}</span>
    </span>
  );
}

function meta(media: Media, kind: string): string {
  return [formatBytes(media.sizeBytes), kind].filter(Boolean).join(' · ');
}

function Attachment({ media, kind, url }: { media: Media; kind: string; url?: string | undefined }) {
  const status =
    media.status === 'STORED' ? null : media.status === 'PENDING' ? 'being fetched' : media.status === 'REJECTED' ? `rejected${media.rejectionReason ? `: ${media.rejectionReason}` : ''}` : 'could not be stored';
  const inner: ReactNode = (
    <>
      <span className="thumb">{fileBadge(media.mimeType, media.filename)}</span>
      <span>
        <b>{media.filename ?? media.mimeType}</b>
        <br />
        <span className="mono-sm">{[meta(media, kind), status].filter(Boolean).join(' · ')}</span>
      </span>
    </>
  );
  return url && media.status === 'STORED' ? (
    <a className="att" href={url} target="_blank" rel="noopener noreferrer" download={media.filename}>
      {inner}
    </a>
  ) : (
    <span className="att">{inner}</span>
  );
}
