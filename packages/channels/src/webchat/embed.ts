import { validation } from '@ocso/domain';
import type { EmbeddedChat, EmbedSession, EmbedVisitor, EmbedWidgetConfig } from '../contract/embed.js';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { attachmentKeyPrefix } from './attachments.js';
import { resolveWebChatConfig } from './config.js';
import { WebChatAuthError } from './errors.js';
import { verifyHostJwt } from './host-jwt.js';
import { identifyToken } from './identity.js';
import { isVisitorToken, issueVisitorToken, newVisitorId, verifyVisitorToken } from './visitor-token.js';

/**
 * Web chat's side of the public widget protocol (contract/embed.ts): settings,
 * channel-bound visitor tokens and host-site JWTs. The OCSO API serves the
 * endpoints and calls these for every embeddable channel.
 */
export function webChatEmbed(now: () => Date): EmbeddedChat {
  return {
    widgetConfig(config: ChannelRuntimeConfig): EmbedWidgetConfig {
      const cfg = resolveWebChatConfig(config);
      return {
        allowedOrigins: cfg.settings.allowedOrigins,
        branding: cfg.settings.branding,
        maxAttachmentsPerMessage: cfg.settings.maxAttachmentsPerMessage,
        hostIdentity: Boolean(cfg.hostJwtSecret),
      };
    },

    openSession(config, request): EmbedSession {
      const cfg = resolveWebChatConfig(config);
      const at = now();
      let visitorId = newVisitorId();
      let externalCustomerRef: string | undefined;
      if (request.visitorToken && isVisitorToken(request.visitorToken)) {
        try {
          const claims = verifyVisitorToken(request.visitorToken, cfg.visitorTokenSecret, { channelId: cfg.channelId, now: at });
          visitorId = claims.visitorId;
          externalCustomerRef = claims.externalCustomerRef;
        } catch {
          // Expired or foreign token: start a new anonymous visitor.
        }
      }
      if (request.hostToken) {
        if (!cfg.hostJwtSecret) throw validation('host_auth_disabled', 'Authenticated customers are not enabled for this channel');
        const claims = verifyHostJwt(request.hostToken, cfg.hostJwtSecret, { issuer: cfg.settings.hostJwtIssuer, audience: cfg.settings.hostJwtAudience, now: at });
        externalCustomerRef = claims.customerRef;
      }
      const issued = issueVisitorToken({ channelId: cfg.channelId, visitorId, externalCustomerRef, ttlSeconds: cfg.settings.visitorTokenTtlSeconds }, cfg.visitorTokenSecret, at);
      return { token: issued.token, visitorId: issued.visitorId, expiresAt: issued.expiresAt, authenticated: Boolean(externalCustomerRef) };
    },

    identify(config, bearerToken): EmbedVisitor {
      if (!bearerToken) throw new WebChatAuthError('missing', 'Visitor token required');
      return identifyToken(bearerToken, resolveWebChatConfig(config), now());
    },

    attachmentKeyPrefix(config, visitor): string {
      return attachmentKeyPrefix(config.id, visitor);
    },
  };
}
