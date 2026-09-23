/** Visible strings of the built-in components (web and React Native). No DOM here. */

/** Visible strings (override for other languages). */
export interface OcsoChatLabels {
  log: string;
  you: string;
  assistant: string;
  agent: string;
  input: string;
  placeholder: string;
  send: string;
  attach: string;
  removeAttachment: (name: string) => string;
  typing: (name: string | undefined) => string;
  failed: string;
  retry: string;
  discard: string;
  reconnecting: string;
  offline: string;
  error: string;
  tryAgain: string;
  unavailable: string;
  fileTooLarge: string;
  fileTypeNotAllowed: string;
  tooManyFiles: (max: number) => string;
  csatQuestion: string;
  csatThanks: string;
  csatScore: (score: number) => string;
  choicesGroup: string;
}

export const defaultLabels: OcsoChatLabels = {
  log: 'Chat messages',
  you: 'You',
  assistant: 'Assistant',
  agent: 'Support',
  input: 'Message',
  placeholder: 'Write a message…',
  send: 'Send',
  attach: 'Attach a file',
  removeAttachment: (name) => `Remove ${name}`,
  typing: (name) => `${name ?? 'Assistant'} is typing…`,
  failed: 'Not sent.',
  retry: 'Retry',
  discard: 'Delete',
  reconnecting: 'Reconnecting…',
  offline: 'You are offline. Messages will send when you reconnect.',
  error: 'Chat is unavailable right now.',
  tryAgain: 'Try again',
  unavailable: 'Attachment unavailable',
  fileTooLarge: 'That file is too large.',
  fileTypeNotAllowed: 'That file type is not supported.',
  tooManyFiles: (max) => `You can attach up to ${max} files.`,
  csatQuestion: 'How did we do?',
  csatThanks: 'Thanks for your feedback!',
  csatScore: (score) => `${score} out of 5`,
  choicesGroup: 'Suggested replies',
};
