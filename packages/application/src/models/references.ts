import { eq, inArray, or, sql } from 'drizzle-orm';
import { modelProfiles, virtualAgents, type DbOrTx } from '@ocso/db';

/** Who references what: provider → profiles (primary or fallback), profile → agents. */

export interface ProviderProfileRef {
  id: string;
  name: string;
  role: 'PRIMARY' | 'FALLBACK';
}

export interface ProfileAgentRef {
  id: string;
  name: string;
  usage: 'MODEL' | 'SUMMARIZER' | 'COPILOT';
}

type ProfileLink = Pick<typeof modelProfiles.$inferSelect, 'id' | 'name' | 'providerId' | 'fallbacks'>;

const profileLinkColumns = {
  id: modelProfiles.id,
  name: modelProfiles.name,
  providerId: modelProfiles.providerId,
  fallbacks: modelProfiles.fallbacks,
};

function refsFor(providerId: string, profiles: readonly ProfileLink[]): ProviderProfileRef[] {
  const refs: ProviderProfileRef[] = [];
  for (const p of profiles) {
    if (p.providerId === providerId) refs.push({ id: p.id, name: p.name, role: 'PRIMARY' });
    else if (p.fallbacks.some((f) => f.providerId === providerId)) refs.push({ id: p.id, name: p.name, role: 'FALLBACK' });
  }
  return refs;
}

/** Profiles that use a provider as primary or fallback target. */
export async function profilesUsingProvider(db: DbOrTx, providerId: string): Promise<ProviderProfileRef[]> {
  const rows = await db
    .select(profileLinkColumns)
    .from(modelProfiles)
    .where(or(eq(modelProfiles.providerId, providerId), sql`${modelProfiles.fallbacks} @> ${JSON.stringify([{ providerId }])}::jsonb`));
  return refsFor(providerId, rows);
}

/** Profile references for every provider in one pass (list views). */
export async function profilesByProvider(db: DbOrTx, providerIds: readonly string[]): Promise<Map<string, ProviderProfileRef[]>> {
  const rows = await db.select(profileLinkColumns).from(modelProfiles).orderBy(modelProfiles.name);
  return new Map(providerIds.map((id) => [id, refsFor(id, rows)]));
}

/** Agents that reference each profile (as model, summarizer or copilot profile). */
export async function agentsByProfile(db: DbOrTx, profileIds: readonly string[]): Promise<Map<string, ProfileAgentRef[]>> {
  const result = new Map<string, ProfileAgentRef[]>(profileIds.map((id) => [id, []]));
  if (!profileIds.length) return result;
  const ids = [...profileIds];
  const agents = await db
    .select({
      id: virtualAgents.id,
      name: virtualAgents.name,
      modelProfileId: virtualAgents.modelProfileId,
      summarizerProfileId: virtualAgents.summarizerProfileId,
      copilotProfileId: virtualAgents.copilotProfileId,
    })
    .from(virtualAgents)
    .where(or(inArray(virtualAgents.modelProfileId, ids), inArray(virtualAgents.summarizerProfileId, ids), inArray(virtualAgents.copilotProfileId, ids)))
    .orderBy(virtualAgents.name);
  for (const a of agents) {
    const uses: Array<[string | null, ProfileAgentRef['usage']]> = [
      [a.modelProfileId, 'MODEL'],
      [a.summarizerProfileId, 'SUMMARIZER'],
      [a.copilotProfileId, 'COPILOT'],
    ];
    for (const [profileId, usage] of uses) {
      if (profileId) result.get(profileId)?.push({ id: a.id, name: a.name, usage });
    }
  }
  return result;
}
