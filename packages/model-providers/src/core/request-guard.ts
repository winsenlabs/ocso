import { validation } from '@ocso/domain';
import type { ModelCapabilities, ModelRequest } from '../contract/types.js';

/**
 * Fail clearly before calling the provider when the request needs a
 * capability the model lacks (docs/06 §4). The prompt compiler normally
 * strips unsupported media; this is the adapter-side guard.
 */
export function assertRequestSupported(request: ModelRequest, caps: ModelCapabilities, model: string): void {
  const missing = (capability: string) =>
    validation('model_capability_missing', `Model ${model} does not support ${capability}`, { model, capability });

  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    throw validation('model_request_invalid', 'maxOutputTokens must be a positive integer');
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw validation('model_request_invalid', 'timeoutMs must be positive');
  }
  if (request.tools.length > 0 && !caps.toolCalling) throw missing('toolCalling');
  if (request.responseSchema && !caps.structuredOutput) throw missing('structuredOutput');
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === 'image' && !caps.imageInput) throw missing('imageInput');
      if (part.type === 'file') {
        const isAudio = part.mimeType.startsWith('audio/');
        const isImage = part.mimeType.startsWith('image/');
        if (isAudio && !caps.audioInput) throw missing('audioInput');
        if (isImage && !caps.imageInput) throw missing('imageInput');
        if (!isAudio && !isImage && !caps.fileInput) throw missing('fileInput');
      }
    }
  }
}
