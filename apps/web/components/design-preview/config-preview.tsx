import { KeyValue } from '@/components/ui/key-value';
import { PromptComponentCard } from '@/components/ui/prompt-component-card';
import { ProviderCard } from '@/components/ui/provider-card';
import { StatusChip } from '@/components/ui/status-chip';
import { VersionRow } from '@/components/ui/version-row';
import { PreviewSection } from './preview-section';

/** Prompt components, version rows and provider cards (design/02, 04). */
export function ConfigPreview() {
  return (
    <PreviewSection title="Configuration surfaces">
      <div>
        <PromptComponentCard index={1} name="Runtime contract" owner="owned by platform · read only" tokens={412}>
          Injected by OCSO. Defines turn structure, tool-call protocol and refusal handling.
        </PromptComponentCard>
        <PromptComponentCard
          index={4}
          name="Behavior"
          owner="cs lead"
          tokens={254}
          edited
          badge={<StatusChip tone="accent">edited · unsaved</StatusChip>}
          action={
            <button type="button" className="btn tiny ghost">
              Revert
            </button>
          }
        >
          {'• Open with the customer’s own words.\n• Ask for at most one identifier at a time.'}
        </PromptComponentCard>
      </div>
      <div className="dtable">
        <VersionRow version="v14" title="Duplicate-debit path shortened" sub="Behavior, Tool instructions · hash pc_4f81…a20c" who="A. Rao" when="12 Mar 11:20" live />
        <VersionRow version="v13" title="Hardship disclosure wording" who="A. Rao" when="28 Feb" />
      </div>
      <div className="g g3">
        <ProviderCard
          logo="AWS"
          name="AWS Bedrock"
          status={{ tone: 'good', label: 'connected' }}
          metrics={[
            { label: 'p95', value: '1.2s' },
            { label: 'tokens today', value: '24.1M' },
          ]}
        >
          <KeyValue
            template="minmax(72px,84px) minmax(0,1fr)"
            fontSize={12}
            items={[
              { k: 'region', v: 'ap-south-1' },
              { k: 'auth', v: 'IAM role · secret ref sec_bdrk_01' },
            ]}
          />
        </ProviderCard>
        <ProviderCard logo="SVM" name="Sarvam" tone="warn" status={{ tone: 'warn', label: 'elevated errors' }} metrics={[{ label: 'p95', value: '2.2s' }, { label: 'error rate', value: '1.8%' }]} />
        <ProviderCard logo="AWS" name="AWS Bedrock" tone="danger" status={{ tone: 'danger', label: 'throttled' }} metrics={[{ label: 'p95', value: '2.9s' }, { label: 'error rate', value: '4.1%' }]} />
      </div>
    </PreviewSection>
  );
}
