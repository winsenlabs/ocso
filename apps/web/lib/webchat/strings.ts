/**
 * Customer-facing copy of the web chat widget. Every string the customer can
 * see or hear (including screen-reader-only text) lives here, keyed, so a
 * locale is one more dictionary. Placeholders use {name}.
 */

const en = {
  'header.subtitle.ai': 'Virtual assistant · replies instantly',
  'header.subtitle.waiting': 'Connecting you to a colleague…',
  'header.subtitle.human': '{name} from our team is here',
  'header.subtitle.humanNoName': 'A colleague from our team is here',
  'header.subtitle.closed': 'Conversation closed · write to reopen',
  'header.close': 'Close chat',
  'log.label': 'Conversation',
  'log.empty': 'Send a message to start the conversation.',
  'log.loading': 'Loading your conversation…',
  'author.you': 'You',
  'author.assistant': '{name} · AI assistant',
  'author.assistantNoName': 'AI assistant',
  'author.human': '{name} · Support team',
  'author.humanNoName': 'Support team',
  'notice.waiting': 'Connecting you to a colleague…',
  'notice.joined': '{name} joined the conversation',
  'notice.joinedNoName': 'A colleague joined the conversation',
  'notice.ai_resumed': 'You’re back with {name}',
  'notice.ai_resumedNoName': 'You’re back with the assistant',
  'notice.resolved': 'This conversation was closed',
  'typing.assistant': '{name} is typing…',
  'typing.assistantNoName': 'The assistant is typing…',
  'typing.tool': '{name} is looking that up…',
  'typing.toolNoName': 'Looking that up…',
  'delivery.sending': 'Sending…',
  'delivery.sent': 'Sent',
  'delivery.delivered': 'Delivered',
  'delivery.read': 'Read',
  'delivery.failed': 'Not sent',
  'delivery.retry': 'Retry',
  'delivery.discard': 'Remove',
  'composer.label': 'Message',
  'composer.placeholder': 'Write a message…',
  'composer.placeholderHuman': 'Write to {name}…',
  'composer.send': 'Send message',
  'composer.attach': 'Attach a file',
  'composer.hint': 'Enter to send · Shift+Enter for a new line',
  'composer.tooLong': '{count} characters over the limit',
  'attachment.remove': 'Remove {name}',
  'attachment.uploading': 'Uploading {name}',
  'attachment.failed': '{name} could not be uploaded',
  'attachment.tooLarge': '{name} is larger than {limit}',
  'attachment.typeNotAllowed': '{name} is not a supported file type',
  'attachment.tooMany': 'You can attach up to {count} files',
  'attachment.none': 'Attachments are not available in this chat',
  'attachment.unavailable': 'Attachment unavailable',
  'attachment.open': 'Open {name}',
  'attachment.image': 'Image {name}',
  'attachment.accepts': 'Images, PDFs and documents up to {limit}',
  'status.connecting': 'Connecting…',
  'status.reconnecting': 'Connection lost. Reconnecting…',
  'status.reconnectingIn': 'Connection lost. Reconnecting in {seconds}s…',
  'status.offline': 'You’re offline. Messages will send when you reconnect.',
  'status.reconnect': 'Reconnect now',
  'status.error': 'Something went wrong. Please try again.',
  'status.sessionFailed': 'We couldn’t start the chat. Check your connection and try again.',
  'status.retry': 'Try again',
  'identify.failed': 'We couldn’t confirm your account; you’re chatting as a guest.',
  'unavailable.title': 'Chat is unavailable',
  'unavailable.body': 'This chat isn’t available right now. Please try again later.',
  'launcher.new': '{count} new messages',
  'a11y.newMessage': 'New message from {author}',
  'time.now': 'now',
} as const;

export type StringKey = keyof typeof en;
export type Dictionary = Readonly<Record<StringKey, string>>;

const DICTIONARIES: Readonly<Record<string, Dictionary>> = { en };

export function pickLocale(preferred: readonly string[] | undefined): string {
  for (const tag of preferred ?? []) {
    const base = tag.toLowerCase().split('-')[0] ?? '';
    if (DICTIONARIES[base]) return base;
  }
  return 'en';
}

export type Translate = (key: StringKey, vars?: Readonly<Record<string, string | number>>) => string;

export function translator(locale = 'en'): Translate {
  const dict = DICTIONARIES[locale] ?? en;
  return (key, vars) => (dict[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ''));
}

/** Pick the `…NoName` variant when a name is missing: t(named('author.human', name), { name }). */
export function named<K extends StringKey>(key: K, name: string | null | undefined): StringKey {
  const fallback = `${key}NoName` as StringKey;
  return name || !(fallback in en) ? key : fallback;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
