'use client';

/**
 * @winsendotai/ocso-chat-react/native: React Native components (no DOM or
 * react-dom imports). Attachments are `{ uri, name, type }` assets.
 */
export { OcsoChatProvider, useOcsoChatClient, type OcsoChatProviderProps } from '../core/context.js';
export { useOcsoChat, useOcsoChatState, latestChoices, type UseOcsoChatResult } from '../core/hooks.js';
export { defaultLabels, type OcsoChatLabels } from '../core/labels.js';
export { OcsoChatView, type OcsoChatViewProps } from './chat-view.js';
export { NativeChoiceButtons, NativeRichText } from './parts.js';
export { lightTheme, darkTheme, type OcsoChatTheme } from './theme.js';
export type { ChatMessage, ChatState, NativeFile, OcsoChatClient, OcsoChatOptions, Part } from '@winsendotai/ocso-chat';
