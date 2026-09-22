/**
 * In-app notice for the person who submitted a WhatsApp template when
 * WhatsApp's review result arrives (`whatsapp_template.status_changed`).
 */

export interface TemplateStatusEvent {
  templateId: string;
  channelId: string;
  name: string;
  language: string;
  status: string;
  previousStatus: string;
  submittedBy: string | null;
}

export interface TemplateNotice {
  id: string;
  tone: 'good' | 'warn' | 'error';
  text: string;
  href: string;
}

const TEXT: Readonly<Record<string, { tone: TemplateNotice['tone']; text: string }>> = {
  APPROVED: { tone: 'good', text: 'was approved by WhatsApp — execs can now send it' },
  REJECTED: { tone: 'error', text: 'was rejected by WhatsApp — see the reason and submit a corrected version' },
  PAUSED: { tone: 'warn', text: 'was paused by WhatsApp after negative customer feedback' },
  DISABLED: { tone: 'error', text: 'was disabled by WhatsApp and can no longer be sent' },
  PENDING: { tone: 'warn', text: 'is back in WhatsApp review' },
};

/** A notice for the submitter only (others see the change on the templates page). */
export function templateNotice(eventId: string, event: TemplateStatusEvent, meId: string): TemplateNotice | null {
  if (event.submittedBy !== meId) return null;
  const known = TEXT[event.status];
  if (!known) return null;
  return {
    id: eventId,
    tone: known.tone,
    text: `Template ${event.name} (${event.language}) ${known.text}.`,
    href: `/whatsapp-templates?channel=${encodeURIComponent(event.channelId)}`,
  };
}
