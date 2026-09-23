import { validation } from '@ocso/domain';
import type {
  EmbeddedChat,
  EmbedSession,
  EmbedSessionHooks,
  EmbedSessionPass,
  EmbedSessionPassRequest,
  EmbedSessionRequest,
  EmbedVisitor,
  EmbedWidgetConfig,
} from '../contract/embed.js';
import type { ChannelFetch, ChannelRuntimeConfig } from '../contract/types.js';
import { attachmentKeyPrefix } from './attachments.js';
import { resolveWebChatConfig, type ResolvedWebChatConfig } from './config.js';
import { contextFromClaims, filterContext, type ContextValues } from './context.js';
import { WebChatAuthError } from './errors.js';
import { customerRefValue, identifyToken, WEBCHAT_IDENTITY } from './identity.js';
import { assertSecretKey, mintSessionPass, PASS_TTL, SessionPassError, verifySessionPass } from './session-pass.js';
import { openUserToken, sealUserToken } from './user-token-vault.js';
import { UserTokenError, UserTokenVerifier, type VerifiedUser } from './user-token.js';
import { isVisitorToken, issueVisitorToken, newVisitorId, VisitorId, verifyVisitorToken, type VisitorProof, type VisitorTokenContext } from './visitor-token.js';

/** Held user tokens live at most this long, whatever the token's own `exp` (SPEC §C.4). */
const MAX_HELD_TOKEN_MS = 24 * 3_600_000;

interface SessionFacts {
  /** A visitor id the site's backend put in the pass (kept only while the pass's user is the session's user). */
  pinnedVisitorId?: string | undefined;
  /** The verified user the pass was minted for (`pinnedVisitorId` belongs to them). */
  pinnedFor?: string | undefined;
  ref?: string | undefined;
  name?: string | undefined;
  proof?: VisitorProof | undefined;
  context?: VisitorTokenContext | undefined;
  user?: { token: string; verified: VerifiedUser } | undefined;
}

/**
 * Web chat's side of the public widget protocol (contract/embed.ts): settings,
 * channel-bound visitor tokens, session passes minted by the site's backend,
 * end-user tokens (JWKS or HS256) and site context. The OCSO API serves the
 * endpoints and calls these for every embeddable channel.
 */
export function webChatEmbed(deps: { now: () => Date; fetch: ChannelFetch }): EmbeddedChat {
  const users = new UserTokenVerifier(deps);

  const hold = (cfg: ResolvedWebChatConfig, user: SessionFacts['user'], at: Date) =>
    user && cfg.settings.toolIdentity === 'passthrough' && cfg.secretKey
      ? { sealed: sealUserToken(user.token, cfg.secretKey), expiresAt: new Date(Math.min(user.verified.expiresAt.getTime(), at.getTime() + MAX_HELD_TOKEN_MS)) }
      : undefined;

  /** Facts proven by a session pass (auth modes client/user) — replaces whatever the old token said about the user. */
  async function fromPass(cfg: ResolvedWebChatConfig, pass: string, hooks: EmbedSessionHooks, at: Date): Promise<SessionFacts> {
    const claims = verifySessionPass(pass, cfg.secretKey, { channelId: cfg.channelId, now: at });
    if (!(await hooks.consumeOnce(claims.jti, new Date(claims.exp * 1000)))) throw new SessionPassError('session_pass_used', 'The session pass was already used');
    if (cfg.settings.auth.mode === 'user' && claims.ut !== 1) throw new UserTokenError('user_token_required', 'This chat needs a signed-in user');
    const ctx = claims.ctx ? filterContext(claims.ctx, cfg.settings.context) : {};
    return {
      pinnedVisitorId: claims.v,
      pinnedFor: claims.sub,
      ref: claims.sub,
      name: claims.name,
      proof: claims.ut === 1 ? 'u' : 'p',
      context: Object.keys(ctx).length ? { source: 'host', values: ctx, at } : undefined,
    };
  }

  return {
    widgetConfig(config: ChannelRuntimeConfig): EmbedWidgetConfig {
      const cfg = resolveWebChatConfig(config);
      return {
        allowedOrigins: cfg.settings.allowedOrigins,
        branding: cfg.settings.branding,
        maxAttachmentsPerMessage: cfg.settings.maxAttachmentsPerMessage,
        hostIdentity: UserTokenVerifier.enabled(cfg),
        authMode: cfg.settings.auth.mode,
        allowNativeApps: cfg.settings.auth.allowNativeApps,
      };
    },

    async openSession(config, request: EmbedSessionRequest, hooks): Promise<EmbedSession> {
      const cfg = resolveWebChatConfig(config);
      const at = deps.now();
      const { mode } = cfg.settings.auth;
      let previous: ReturnType<typeof verifyVisitorToken> | undefined;
      if (request.visitorToken && isVisitorToken(request.visitorToken)) {
        try {
          previous = verifyVisitorToken(request.visitorToken, cfg.visitorTokenSecret, { channelId: cfg.channelId, now: at });
        } catch {
          // Expired or foreign token: start a new visitor.
        }
      }
      const userToken = request.userToken ?? request.hostToken;
      let facts: SessionFacts;
      if (request.sessionPass) {
        facts = await fromPass(cfg, request.sessionPass, hooks, at);
      } else if (mode === 'client') {
        throw new SessionPassError('session_pass_required', 'This chat needs a session pass from the site');
      } else if (mode === 'user' && !userToken) {
        throw new UserTokenError('user_token_required', 'This chat needs a signed-in user');
      } else {
        // Anonymous renewal keeps what the old token proved; user mode always re-proves below.
        facts = mode === 'anonymous' && previous
          ? { ref: previous.externalCustomerRef, name: previous.name, proof: previous.proof, context: previous.context }
          : {};
      }
      if (userToken) {
        const verified = await users.verify(userToken, cfg);
        const claimed = contextFromClaims(verified.claims, cfg.settings.context);
        const hostValues = { ...(facts.context?.source === 'host' ? facts.context.values : {}), ...claimed };
        facts = {
          ...facts,
          ref: verified.sub,
          name: verified.name ?? facts.name,
          proof: 'u',
          context: Object.keys(hostValues).length ? { source: 'host', values: hostValues, at } : facts.context,
          user: { token: userToken, verified },
        };
      }
      if (request.context !== undefined && facts.context?.source !== 'host') {
        const values = filterContext(request.context, cfg.settings.context);
        facts.context = Object.keys(values).length ? { source: 'client', values, at } : facts.context;
      }
      const issued = issueVisitorToken(
        {
          channelId: cfg.channelId,
          visitorId: visitorIdFor(facts, previous),
          externalCustomerRef: facts.ref,
          proof: facts.proof,
          name: facts.name,
          context: facts.context,
          ttlSeconds: cfg.settings.visitorTokenTtlSeconds,
        },
        cfg.visitorTokenSecret,
        at,
      );
      const visitor = identifyToken(issued.token, cfg, at);
      return { token: issued.token, visitorId: issued.visitorId, expiresAt: issued.expiresAt, authenticated: Boolean(facts.ref), visitor, userToken: hold(cfg, facts.user, at) };
    },

    async mintSessionPass(config, request: EmbedSessionPassRequest): Promise<EmbedSessionPass> {
      const cfg = resolveWebChatConfig(config);
      assertSecretKey(request.secretKey, cfg.secretKey);
      const at = deps.now();
      if (request.visitorId !== undefined && !VisitorId.safeParse(request.visitorId).success) {
        throw validation('invalid_visitor_id', 'visitorId must be 8-128 url-safe characters');
      }
      let verified: VerifiedUser | undefined;
      if (request.userToken) verified = await users.verify(request.userToken, cfg);
      else if (cfg.settings.auth.mode === 'user') throw new UserTokenError('user_token_required', 'This channel needs a verified userToken in every session pass');
      const values: ContextValues = {
        ...filterContext(request.context, cfg.settings.context),
        ...(verified ? contextFromClaims(verified.claims, cfg.settings.context) : {}),
      };
      const minted = mintSessionPass(
        {
          channelId: cfg.channelId,
          ttlSeconds: request.ttlSeconds ?? PASS_TTL.default,
          visitorId: request.visitorId,
          sub: verified?.sub,
          name: verified?.name,
          context: filterContext(values, cfg.settings.context),
          userVerified: Boolean(verified),
        },
        cfg.secretKey!,
        at,
      );
      const held = verified ? hold(cfg, { token: request.userToken!, verified }, at) : undefined;
      const visitor = verified
        ? {
            identityKind: WEBCHAT_IDENTITY.CUSTOMER_REF,
            identityValue: customerRefValue(cfg.channelId, verified.sub),
            alternateIdentities: request.visitorId ? [{ kind: WEBCHAT_IDENTITY.VISITOR, value: request.visitorId }] : [],
            profileName: verified.name,
          }
        : undefined;
      return { sessionPass: minted.pass, expiresAt: minted.expiresAt, userToken: held && visitor ? { ...held, visitor } : undefined };
    },

    async identify(config, bearerToken): Promise<EmbedVisitor> {
      if (!bearerToken) throw new WebChatAuthError('missing', 'Visitor token required');
      return identifyToken(bearerToken, resolveWebChatConfig(config), deps.now());
    },

    attachmentKeyPrefix(config, visitor): string {
      return attachmentKeyPrefix(config.id, visitor);
    },

    openUserToken(config, sealed): string | null {
      const cfg = resolveWebChatConfig(config);
      // Held tokens go out only while the channel still passes user tokens through (switching back to 'ocso' stops them at once).
      if (cfg.settings.toolIdentity !== 'passthrough' || !cfg.secretKey) return null;
      return openUserToken(sealed, cfg.secretKey);
    },
  };
}

/**
 * The visitor id of the token being issued. The previous token's visitor (this browser's) carries over only
 * while the user stays the same: it had no verified user, or the same one. A different user, or none after one
 * (someone else on a shared browser who did not sign out), gets a new visitor id, so they never inherit the
 * previous user's conversation, customer or held tokens. A backend-pinned id holds only for the pass's own user.
 */
function visitorIdFor(facts: SessionFacts, previous: { visitorId: string; externalCustomerRef?: string | undefined } | undefined): string {
  if (facts.pinnedVisitorId && facts.pinnedFor === facts.ref) return facts.pinnedVisitorId;
  if (previous && (!previous.externalCustomerRef || previous.externalCustomerRef === facts.ref)) return previous.visitorId;
  return newVisitorId();
}
