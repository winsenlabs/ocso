import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { ErrorCategory, RETRIABLE_CATEGORIES } from '@ocso/domain';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { getCatalogStatus, listMissingPrices } from '@/lib/api/model-catalog';
import { listPricing, listProfiles, listProviderKinds, listProviders, PROVIDER_KINDS, type Provider, type ProviderKind } from '@/lib/api/models';
import { getDeploymentSettings } from '@/lib/api/settings';
import { hasPermission, type Session } from '@/lib/session';
import { PricingDialog } from '../pricing/pricing-dialog';
import { PricingSection } from '../pricing/pricing-section';
import { ProfileDetails } from '../profiles/profile-details';
import { ProfileDialog } from '../profiles/profile-dialog';
import { ProfilesSection } from '../profiles/profiles-table';
import { RoutedModal } from '../routed-modal';
import { connectionsHref, idParam, param } from '../url';
import { ProviderDialog, type ProviderFormModel } from './provider-dialog';
import { ProviderGrid } from './provider-grid';

type Params = Record<string, string | string[] | undefined>;

/** Model-call error categories that may move to a fallback target (docs/06 §5; tool errors never reach a model call). */
const FALLBACK_CATEGORIES = [...RETRIABLE_CATEGORIES].filter((c) => c !== ErrorCategory.TOOL_UNAVAILABLE);

function formModel(p: Provider): ProviderFormModel {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    region: p.region,
    residencyZone: p.residencyZone,
    settings: p.settings,
    credentialKeys: Object.keys(p.secretRefs),
    enabled: p.enabled,
    maxConcurrency: p.maxConcurrency,
    profileNames: p.profiles.map((r) => r.name),
  };
}

/** Model providers tab: provider cards, logical model profiles, pricing, and their URL-driven dialogs. */
export async function ProvidersTab({ session, params }: { session: Session; params: Params }) {
  const canProviders = hasPermission(session, Permission.PROVIDERS_MANAGE);
  const canProfiles = hasPermission(session, Permission.MODEL_PROFILES_MANAGE);
  const canPricing = hasPermission(session, Permission.PRICING_MANAGE);
  const [providers, kinds, profiles, pricing, settings, missing, catalog] = await Promise.all([
    listProviders(),
    listProviderKinds(),
    listProfiles(),
    canPricing ? listPricing() : Promise.resolve(null),
    getDeploymentSettings(),
    canPricing ? listMissingPrices() : Promise.resolve(null),
    canPricing ? getCatalogStatus() : Promise.resolve(null),
  ]);

  const closeHref = connectionsHref({ tab: 'providers' });
  const dialog = param(params, 'dialog');
  const id = idParam(params, 'id');
  const kindParam = kinds.find((k) => k.kind === param(params, 'kind'))?.kind ?? null;
  const provider = id ? providers.find((p) => p.id === id) : undefined;
  const profile = id ? profiles.find((p) => p.id === id) : undefined;
  const price = id ? pricing?.find((p) => p.id === id) : undefined;
  const options = providers.map((p) => ({ id: p.id, name: p.name, kindLabel: p.kindLabel, region: p.region, residencyZone: p.residencyZone, enabled: p.enabled }));
  // "Add price" from a model without one: pre-fill the model and the catalog's offer.
  const priceKind = PROVIDER_KINDS.find((k) => k === param(params, 'kind'));
  const priceModel = param(params, 'model');
  const priceInitial =
    priceKind && priceModel
      ? { kind: priceKind, model: priceModel, suggestion: missing?.find((m) => m.providerKind === priceKind && m.model === priceModel)?.catalog ?? null }
      : undefined;

  return (
    <>
      <SecHead
        title="Model providers"
        count={`${providers.length} configured · ${kinds.length} kinds available`}
        desc="credentials are write-only and stored by reference"
        actions={
          canProviders ? (
            <Link className="btn tiny accent" href={connectionsHref({ tab: 'providers', dialog: 'provider-new' })} scroll={false}>
              Add provider
            </Link>
          ) : null
        }
      />
      <ProviderGrid providers={providers} kinds={kinds} canManage={canProviders} />
      <ProfilesSection profiles={profiles} canManage={canProfiles} hasProviders={providers.length > 0} />
      {pricing ? <PricingSection pricing={pricing} kinds={kinds} timezone={settings.timezone} missing={missing} catalog={catalog} /> : null}

      {canProviders && (dialog === 'provider-new' || (dialog === 'provider-edit' && provider)) ? (
        <ProviderDialog
          key={provider?.id ?? `new-${kindParam ?? ''}`}
          kinds={kinds}
          initialKind={(kindParam as ProviderKind | null) ?? null}
          provider={provider ? formModel(provider) : null}
          closeHref={closeHref}
        />
      ) : null}
      {canProfiles && (dialog === 'profile-new' || (dialog === 'profile-edit' && profile)) ? (
        options.length ? (
          <ProfileDialog
            key={profile?.id ?? 'new'}
            providers={options}
            profile={profile ?? null}
            fallbackCategories={FALLBACK_CATEGORIES}
            canTest={canProviders}
            canRefreshModels={canProviders}
            canPricing={canPricing}
            closeHref={closeHref}
          />
        ) : (
          <RoutedModal title="New logical model profile" closeHref={closeHref} maxWidth={520}>
            <EmptyState title="Configure a model provider first">A profile points at a provider’s model or deployment. Add a provider, then create the profile.</EmptyState>
          </RoutedModal>
        )
      ) : null}
      {dialog === 'profile-view' && profile ? <ProfileDetails profile={profile} closeHref={closeHref} /> : null}
      {canPricing && (dialog === 'pricing-new' || (dialog === 'pricing-edit' && price)) ? (
        <PricingDialog key={price?.id ?? `new-${priceKind ?? ''}-${priceModel ?? ''}`} kinds={kinds} row={price ?? null} closeHref={closeHref} initial={price ? undefined : priceInitial} />
      ) : null}
    </>
  );
}
