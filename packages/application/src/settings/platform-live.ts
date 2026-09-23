import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { authSsoProviders, channels, mcpConnections, modelPricing, modelProviders, notificationDestinations, webhookSubscriptions, type DbOrTx } from '@ocso/db';

/**
 * Whether a platform object is live configuration right now — the same test as each descriptor's
 * liveObjects(), for one row. A live object is governed (every change a proposal) whether or not it carries
 * an approval: on a deployment upgraded before the grandfather migration (0031) records one, a live
 * channel, provider or SSO provider must never fall back to the draft path. Model profiles (live = in use)
 * and catalog prices are judged by their own services, which pass `governed` to assertPlatformWrite.
 */
export async function isLivePlatformObject(tx: DbOrTx, kind: string, id: string): Promise<boolean> {
  const one = async (rows: Promise<unknown[]>) => (await rows).length > 0;
  switch (kind) {
    case 'channel':
      return one(tx.select({ id: channels.id }).from(channels).where(and(eq(channels.id, id), eq(channels.status, 'ACTIVE'))));
    case 'model_provider':
      return one(tx.select({ id: modelProviders.id }).from(modelProviders).where(and(eq(modelProviders.id, id), eq(modelProviders.enabled, true))));
    case 'model_pricing':
      return one(tx.select({ id: modelPricing.id }).from(modelPricing).where(and(eq(modelPricing.id, id), eq(modelPricing.status, 'ACTIVE'), eq(modelPricing.origin, 'manual'))));
    case 'mcp_connection':
      return one(
        tx
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(and(eq(mcpConnections.id, id), isNull(mcpConnections.ownerUserId), isNotNull(mcpConnections.approvedAt), ne(mcpConnections.status, 'DISABLED'))),
      );
    case 'notification_destination':
      return one(tx.select({ id: notificationDestinations.id }).from(notificationDestinations).where(and(eq(notificationDestinations.id, id), eq(notificationDestinations.enabled, true))));
    case 'webhook_subscription':
      return one(tx.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.enabled, true))));
    case 'sso_provider':
      return one(tx.select({ id: authSsoProviders.id }).from(authSsoProviders).where(and(eq(authSsoProviders.id, id), eq(authSsoProviders.status, 'ACTIVE'))));
    case 'deployment_settings':
      return true;
    default:
      return false;
  }
}
