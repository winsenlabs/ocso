/**
 * @winsendotai/ocso-chat: headless client for OCSO web chat.
 * Works in browsers and React Native; zero runtime dependencies.
 */
export { createOcsoChat } from './client.js';
export { ChatApiError, mimeTypeOf } from './api.js';
export { linkify, type TextSegment } from './linkify.js';
export { createSseParser, backoffDelay, type SseMessage, type SseParser, type BackoffOptions } from './sse.js';
export { memoryStorage } from './platform.js';
export { noticeText, CHOICES_SCHEMA, CHOICE_REPLY_SCHEMA } from './view.js';
export { checkAttachment, acceptedMimeTypes, attachmentsEnabled, type AttachmentCheck } from './files.js';
export type {
  AbortSignalLike,
  AttachmentInput,
  AuthMode,
  BlobLike,
  ChatContext,
  ChatError,
  ChatEventName,
  ChatEvents,
  ChatMessage,
  ChatNotice,
  ChatState,
  ChatStatus,
  ChatStorage,
  ChoiceOption,
  ContextValue,
  ConversationMode,
  CsatResult,
  FetchLike,
  MediaKind,
  NativeFile,
  NoticeKind,
  OcsoChatClient,
  OcsoChatOptions,
  Part,
  ResponseLike,
  SendInput,
  StreamReaderLike,
  TransportPreference,
  UploadResult,
  WebChatBranding,
  WebChatConfig,
} from './types.js';

export const OCSO_CHAT_VERSION = '0.1.0';
