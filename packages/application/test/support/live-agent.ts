import { eq } from 'drizzle-orm';
import { modelProfiles, modelProviders, uuidv7, virtualAgents, type Db } from '@ocso/db';

/**
 * Put an agent in the state going live requires (liveReadiness): LIVE with a
 * model profile. Routing only hands customers to agents that answer; any
 * other agent's customers go to a person (PM/research/11 §5.3).
 */
export async function makeLive(db: Db, agentId: string): Promise<void> {
  const providerId = uuidv7();
  const profileId = uuidv7();
  await db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: `Scripted ${providerId.slice(-6)}`, residencyZone: 'IN' });
  await db.insert(modelProfiles).values({ id: profileId, name: `profile ${profileId.slice(-6)}`, providerId, model: 'scripted' });
  await db.update(virtualAgents).set({ status: 'LIVE', modelProfileId: profileId }).where(eq(virtualAgents.id, agentId));
}
