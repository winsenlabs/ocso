/** Human-readable explanations of target rejection reasons (fallback-policy RejectionReason + availability). */
export function targetReasonText(
  target: { providerName: string; providerKind: string; residencyZone: string | null; reason: string | null },
  context: { requiredZone: string | null },
): string {
  const reason = target.reason ?? '';
  if (reason.startsWith('missing_capability:')) return `the model lacks the required capability ${reason.slice('missing_capability:'.length)}`;
  switch (reason) {
    case 'provider_not_allowlisted':
      return `${target.providerName} is not on the deployment's provider allowlist`;
    case 'residency_violation':
      return `${target.providerName} keeps data in ${target.residencyZone ?? 'an unspecified zone'}, but this deployment requires ${context.requiredZone}`;
    case 'cross_provider_forbidden':
      return 'cross-provider fallback is disabled by deployment policy';
    case 'cross_region_forbidden':
      return 'cross-region fallback is disabled by deployment policy';
    case 'cost_ceiling_exceeded':
      return 'the output price exceeds the deployment cost ceiling';
    case 'provider_disabled':
      return `${target.providerName} is disabled`;
    case 'provider_kind_not_available':
      return `${target.providerKind} providers are not available in this deployment`;
    case 'provider_configuration_invalid':
      return `the stored ${target.providerName} configuration is invalid`;
    default:
      return reason || 'not permitted';
  }
}
