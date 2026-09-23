import { Permission } from '@ocso/auth';
import { SecHead } from '@/components/ui/sec-head';
import { getAssistantSettings, getRetention } from '@/lib/api/governance';
import { listProfiles } from '@/lib/api/models';
import { hasPermission, requireSession } from '@/lib/session';
import { AssistantForm } from './assistant-form';
import { RetentionForm } from './retention-form';

/** Data retention for everyone to read; retention and Ask OCSO edits for the Tech admin. */
export async function GovernanceSection() {
  const session = await requireSession();
  const canEdit = hasPermission(session, Permission.DEPLOYMENT_SETTINGS_MANAGE);
  const [retention, assistant, profiles] = await Promise.all([
    getRetention(),
    canEdit ? getAssistantSettings() : Promise.resolve(null),
    canEdit ? listProfiles().catch(() => []) : Promise.resolve([]),
  ]);
  return (
    <div className="row2" style={{ marginTop: 24 }}>
      <div>
        <SecHead title="Data retention" desc={canEdit ? 'Tech admin' : 'read only · managed by the Tech admin'} />
        <RetentionForm rows={retention} editable={canEdit} />
      </div>
      {assistant ? (
        <div>
          <SecHead title="Ask OCSO" desc="internal agent · inherits each user's permissions" />
          <AssistantForm profiles={profiles.map((p) => ({ id: p.id, name: p.name }))} profileId={assistant.internalAgentProfileId} writesEnabled={assistant.askOcsoWrites} />
        </div>
      ) : null}
    </div>
  );
}
