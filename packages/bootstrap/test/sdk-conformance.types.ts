/**
 * Drift guard (type level): every contract type the public plugin SDK
 * (@winsendotai/ocso-plugin-sdk) declares must be mutually assignable with
 * its internal twin. This file is compiled by `pnpm typecheck` (the package
 * tsconfig includes test/); it has no runtime part. When an internal contract
 * changes, the matching line fails here until the SDK copy changes too (and
 * the SDK's release notes say so; a breaking change raises
 * OCSO_PLUGIN_API_VERSION).
 */
import type * as Alerts from '@ocso/alerts';
import type * as Channels from '@ocso/channels';
import type * as Domain from '@ocso/domain';
import type * as Email from '@ocso/email';
import type * as Models from '@ocso/model-providers';
import type * as Sdk from '@winsendotai/ocso-plugin-sdk';
import type { AlertDestinationFactory, ChannelAdapterFactory, OcsoPlugin } from '../src/plugin.js';

/**
 * `true` only when A and B are the same type. Mutual assignability is not enough: method parameters are
 * compared bivariantly (a narrowed or widened parameter, or an added optional one, passes both ways) and an
 * optional member dropped from a nested inline object passes too. `Identical` uses TypeScript's identity
 * relation (the deferred-conditional trick), which compares members, optionality, readonly and parameters
 * exactly, all the way down. `Mutual` stays as a second, more readable check.
 */
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Mutual<A, B> = Assignable<A, B> extends true ? Assignable<keyof A, keyof B> : false;
type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Same<A, B> = Mutual<A, B> extends true ? Identical<A, B> : false;
function same<A, B>(ok: Same<A, B>): void {
  void ok;
}

// ── Domain vocabulary ──
same<Sdk.MediaStatus, Domain.MediaStatus>(true);
same<Sdk.MediaRef, Domain.MediaRef>(true);
same<Sdk.InteractionPart, Domain.InteractionPart>(true);
same<Sdk.InteractionPartType, Domain.InteractionPartType>(true);
same<Sdk.DeliveryStatus, Domain.DeliveryStatus>(true);
same<Sdk.ChoicesData, Domain.ChoicesData>(true);
same<Sdk.MessageTemplate, Domain.MessageTemplate>(true);
same<Sdk.TemplateDraft, Domain.TemplateDraft>(true);
same<Sdk.TemplateStatus, Domain.TemplateStatus>(true);
same<Sdk.TemplateCategory, Domain.TemplateCategory>(true);
same<Sdk.TemplateVariable, Domain.TemplateVariable>(true);
same<Sdk.TemplateHeader, Domain.TemplateHeader>(true);
same<Sdk.TemplateButton, Domain.TemplateButton>(true);
same<Sdk.CacheBreakpoint, Domain.CacheBreakpoint>(true);
same<Sdk.SystemBlock, Domain.SystemBlock>(true);
same<Sdk.ModelContentPart, Domain.ModelContentPart>(true);
same<Sdk.ToolResultOutput, Domain.ToolResultOutput>(true);
same<Sdk.ModelMessage, Domain.ModelMessage>(true);
same<Sdk.ToolSpec, Domain.ToolSpec>(true);
same<Sdk.MediaResolver, Domain.MediaResolver>(true);
same<Sdk.ErrorCategory, Domain.ErrorCategory>(true);

// ── Channels ──
same<Sdk.ChannelAdapter, Channels.ChannelAdapter>(true);
same<Sdk.ChannelAdapterDeps, Channels.ChannelAdapterDeps>(true);
same<Sdk.ChannelFetch, Channels.ChannelFetch>(true);
same<Sdk.MediaKind, Channels.MediaKind>(true);
same<Sdk.ChannelCapabilities, Channels.ChannelCapabilities>(true);
same<Sdk.RawHttpRequest, Channels.RawHttpRequest>(true);
same<Sdk.ChannelRuntimeConfig, Channels.ChannelRuntimeConfig>(true);
same<Sdk.VerificationResult, Channels.VerificationResult>(true);
same<Sdk.InboundMessage, Channels.InboundMessage>(true);
same<Sdk.InboundHostContext, Channels.InboundHostContext>(true);
same<Sdk.DeliveryStatusUpdate, Channels.DeliveryStatusUpdate>(true);
same<Sdk.IdentityUpdate, Channels.IdentityUpdate>(true);
same<Sdk.TemplateStatusUpdate, Channels.TemplateStatusUpdate>(true);
same<Sdk.InboundEnvelope, Channels.InboundEnvelope>(true);
same<Sdk.FetchedMedia, Channels.FetchedMedia>(true);
same<Sdk.RenderedOutbound, Channels.RenderedOutbound>(true);
same<Sdk.OutboundTarget, Channels.OutboundTarget>(true);
same<Sdk.ReplyContext, Channels.ReplyContext>(true);
same<Sdk.SendResult, Channels.SendResult>(true);
same<Sdk.WebhookAcknowledgement, Channels.WebhookAcknowledgement>(true);
same<Sdk.ConnectionCheck, Channels.ConnectionCheck>(true);
same<Sdk.ConnectionCheckResult, Channels.ConnectionCheckResult>(true);
same<Sdk.TemplateSendRequest, Channels.TemplateSendRequest>(true);
same<Sdk.OutboundMediaResolver, Channels.OutboundMediaResolver>(true);
same<Sdk.ChannelKindDescriptor, Channels.ChannelKindDescriptor>(true);
same<Sdk.ChannelSecretField, Channels.ChannelSecretField>(true);
same<Sdk.ChannelMark, Channels.ChannelMark>(true);
same<Sdk.ChannelIdentitySetting, Channels.ChannelIdentitySetting>(true);
same<Sdk.ChannelTemplateTerms, Channels.ChannelTemplateTerms>(true);
same<Sdk.ChannelSetupFile, Channels.ChannelSetupFile>(true);
same<Sdk.EmbeddedChat, Channels.EmbeddedChat>(true);
same<Sdk.EmbedAuthMode, Channels.EmbedAuthMode>(true);
same<Sdk.EmbedWidgetConfig, Channels.EmbedWidgetConfig>(true);
same<Sdk.EmbedContextValues, Channels.EmbedContextValues>(true);
same<Sdk.EmbedContext, Channels.EmbedContext>(true);
same<Sdk.EmbedSessionRequest, Channels.EmbedSessionRequest>(true);
same<Sdk.EmbedSessionHooks, Channels.EmbedSessionHooks>(true);
same<Sdk.EmbedHeldUserToken, Channels.EmbedHeldUserToken>(true);
same<Sdk.EmbedSession, Channels.EmbedSession>(true);
same<Sdk.EmbedSessionPassRequest, Channels.EmbedSessionPassRequest>(true);
same<Sdk.EmbedSessionPass, Channels.EmbedSessionPass>(true);
same<Sdk.EmbedVisitor, Channels.EmbedVisitor>(true);

// ── Model providers ──
same<Sdk.ProviderDefinition, Models.ProviderDefinition>(true);
same<Sdk.ProviderDefinition<{ region: string }, { apiKey: string }>, Models.ProviderDefinition<{ region: string }, { apiKey: string }>>(true);
same<Sdk.ProviderCatalogMapping, Models.ProviderCatalogMapping>(true);
same<Sdk.CatalogSource, Models.CatalogSource>(true);
same<Sdk.CatalogCandidate, Models.CatalogCandidate>(true);
same<Sdk.ModelProviderAdapter, Models.ModelProviderAdapter>(true);
same<Sdk.ModelCapabilities, Models.ModelCapabilities>(true);
same<Sdk.ModelPurpose, Models.ModelPurpose>(true);
same<Sdk.ModelRequest, Models.ModelRequest>(true);
same<Sdk.ModelResult, Models.ModelResult>(true);
same<Sdk.ModelStreamEvent, Models.ModelStreamEvent>(true);
same<Sdk.NormalizedUsage, Models.NormalizedUsage>(true);
same<Sdk.ModelIdentity, Models.ModelIdentity>(true);
same<Sdk.ToolCallRequest, Models.ToolCallRequest>(true);
same<Sdk.FinishReason, Models.FinishReason>(true);
same<Sdk.ProviderHealth, Models.ProviderHealth>(true);
same<Sdk.ProviderRuntimeConfig, Models.ProviderRuntimeConfig>(true);
same<Sdk.AdapterDeps, Models.AdapterDeps>(true);
same<Sdk.ProviderModelInfo, Models.ProviderModelInfo>(true);
same<Sdk.ListModelsOptions, Models.ListModelsOptions>(true);
same<Sdk.ProviderOptions, Models.ProviderOptions>(true);
same<Sdk.ProviderOptionsPlan, Models.ProviderOptionsPlan>(true);
same<Sdk.PromptCachingDescription, Models.PromptCachingDescription>(true);

// ── Alert destinations ──
same<Sdk.AlertDeliveryAdapter, Alerts.AlertDeliveryAdapter>(true);
same<Sdk.AlertDeliveryAdapter<{ channel: string }>, Alerts.AlertDeliveryAdapter<{ channel: string }>>(true);
same<Sdk.AlertMessage, Alerts.AlertMessage>(true);
same<Sdk.AlertEvent, Alerts.AlertEvent>(true);
same<Sdk.DeliveryResult, Alerts.DeliveryResult>(true);
same<Sdk.ConfigCheck<{ channel: string }>, Alerts.ConfigCheck<{ channel: string }>>(true);
same<Sdk.SecretRequirement, Alerts.SecretRequirement>(true);
same<Sdk.DeliveryAdapterDeps, Alerts.DeliveryAdapterDeps>(true);
same<Sdk.FetchFn, Alerts.FetchFn>(true);
same<Sdk.MailTransport, Alerts.MailTransport>(true);
same<Sdk.MailTransportFactory, Alerts.MailTransportFactory>(true);
same<Sdk.SmtpTransportOptions, Alerts.SmtpTransportOptions>(true);
same<Sdk.OutgoingMail, Alerts.OutgoingMail>(true);

// ── Email drivers ──
same<Sdk.EmailDriverDefinition, Email.EmailDriverDefinition>(true);
same<Sdk.EmailDriverDefinition<{ apiKey: string }>, Email.EmailDriverDefinition<{ apiKey: string }>>(true);
same<Sdk.EmailSender, Email.EmailSender>(true);
same<Sdk.EmailMessage, Email.EmailMessage>(true);
same<Sdk.EmailSendResult, Email.EmailSendResult>(true);
same<Sdk.EmailErrorCategory, Email.EmailErrorCategory>(true);
same<Sdk.EmailEnv, Email.EmailEnv>(true);
same<Sdk.EmailDriverContext, Email.EmailDriverContext>(true);
same<Sdk.EmailResolveDeps, Email.EmailResolveDeps>(true);
same<Sdk.EmailSenderDeps, Email.EmailSenderDeps>(true);

// ── The plugin envelope ──
same<Sdk.ChannelAdapterFactory, ChannelAdapterFactory>(true);
same<Sdk.AlertDestinationFactory, AlertDestinationFactory>(true);
/** The public contributions of the internal plugin shape, plus the API version handshake. */
type Flat<T> = { [K in keyof T]: T[K] };
type PublicPart = Flat<Pick<OcsoPlugin, 'name' | 'channels' | 'modelProviders' | 'alertDestinations' | 'emailDrivers'> & { readonly apiVersion: 1 }>;
same<Sdk.OcsoPluginV1, PublicPart>(true);
/** An SDK plugin is directly usable as an internal plugin (what the loader appends to the list). */
export const sdkPluginIsInternalPlugin = (plugin: Sdk.OcsoPluginV1): OcsoPlugin => plugin;

// ── The guard itself: drift that mutual assignability misses must fail `same` ──
interface Visitor {
  kind: string;
  value: string;
}
// A method parameter narrowed or widened (methods compare parameters bivariantly).
// @ts-expect-error parameter types differ
same<{ prefix(v: Pick<Visitor, 'kind'>): string }, { prefix(v: Pick<Visitor, 'kind' | 'value'>): string }>(true);
// An optional parameter added.
// @ts-expect-error parameter lists differ
same<{ f(a: string): void }, { f(a: string, o?: { strict: boolean }): void }>(true);
// An optional member dropped from a nested inline object.
// @ts-expect-error nested members differ
same<{ token: { value: string; expiresAt?: string } }, { token: { value: string } }>(true);
// A member made readonly.
// @ts-expect-error modifiers differ
same<{ a: string }, { readonly a: string }>(true);
same<{ f(a: string): void; token: { value: string } }, { f(a: string): void; token: { value: string } }>(true);
