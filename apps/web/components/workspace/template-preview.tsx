import type { RenderedTemplate } from '@ocso/domain';

/**
 * WhatsApp-style preview of a template message (workspace composer and the
 * template builder): header, body, footer and buttons exactly as rendered by
 * @ocso/domain's renderTemplate — the same text OCSO stores and sends.
 */
export function TemplatePreview({ rendered, caption = 'Preview · what the customer receives' }: { rendered: RenderedTemplate; caption?: string }) {
  return (
    <figure className="tplprev" aria-label="Message preview">
      <figcaption className="mono-sm">{caption}</figcaption>
      <div className="bubble">
        {rendered.header ? <p className="hd">{rendered.header}</p> : null}
        <p className="bd">{rendered.body || <span className="mono-sm">No message text yet</span>}</p>
        {rendered.footer ? <p className="ft">{rendered.footer}</p> : null}
      </div>
      {rendered.buttons.length ? (
        <div className="btns">
          {rendered.buttons.map((b, i) => (
            <span key={i} className="tplbtn" title={b.url}>
              {b.text}
            </span>
          ))}
        </div>
      ) : null}
    </figure>
  );
}
