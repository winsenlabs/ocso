'use client';

/**
 * @winsendotai/ocso-chat-react: React hooks and web components for OCSO web chat.
 * React Native components live in `@winsendotai/ocso-chat-react/native`;
 * default styles in `@winsendotai/ocso-chat-react/styles.css`.
 */
export { OcsoChatProvider, useOcsoChatClient, type OcsoChatProviderProps } from './core/context.js';
export { useOcsoChat, useOcsoChatState, latestChoices, type UseOcsoChatResult } from './core/hooks.js';
export { OcsoChat, type OcsoChatProps, type OcsoChatPanelProps } from './web/ocso-chat.js';
export { MessageList, type MessageListProps } from './web/message-list.js';
export { Composer, type ComposerProps } from './web/composer.js';
export { ChoiceButtons, type ChoiceButtonsProps } from './web/choice-buttons.js';
export { TypingIndicator, type TypingIndicatorProps } from './web/typing-indicator.js';
export { RichText, defaultLabels, type OcsoChatClassNames, type OcsoChatLabels, type RenderMessage, type RenderPart } from './web/shared.js';
export type { ChatMessage, ChatState, OcsoChatClient, OcsoChatOptions, Part } from '@winsendotai/ocso-chat';
