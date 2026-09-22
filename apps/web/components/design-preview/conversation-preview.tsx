import { SystemEvent, TimelineEvent, ToolEvent } from '@/components/ui/timeline';
import { PreviewSection } from './preview-section';

/** Timeline pieces from design/01: customer, AI, human and note turns; system and tool events. */
export function ConversationPreview() {
  return (
    <PreviewSection title="Conversation timeline">
      <div className="tl" style={{ background: 'var(--bg)', padding: 16, border: '1px solid var(--border)', borderRadius: 10 }}>
        <SystemEvent>conversation opened · whatsapp · maya v14 · model support-primary · 09:41:06</SystemEvent>
        <TimelineEvent kind="cust" who="PD" author="Priya Deshmukh" role="customer" time="09:41">
          <p>Hi, my EMI got debited twice this month. Card ending 4417. Please reverse one of them.</p>
        </TimelineEvent>
        <TimelineEvent kind="ai" who="MA" author="Maya" role="virtual agent · support" time="09:41">
          <p>Thanks Priya, let me check the two debits on the card ending 4417 right away.</p>
        </TimelineEvent>
        <ToolEvent
          name="cards.list_transactions"
          meta="core-cards · read-only · 690 ms · ok"
          status="ok"
          facts={[
            { k: 'rows', v: '34' },
            { k: 'duplicate pair', v: 'found' },
          ]}
        />
        <ToolEvent
          name="payments.reverse_transaction"
          meta="core-cards · sensitive write · blocked by policy"
          status="fail"
          facts={[{ k: 'requires', v: 'human confirmation' }]}
        />
        <SystemEvent highlight>escalation requested · reason: sensitive refund above authority · 09:52:14</SystemEvent>
        <TimelineEvent kind="note" who="NM" author="Nikhil Menon" role="internal note · not sent to customer" time="09:54">
          Duplicate terminal auth confirmed against the merchant batch file.
        </TimelineEvent>
        <TimelineEvent kind="hum" who="NM" author="Nikhil Menon" role="human · cs exec" time="09:56">
          <p>Hello Priya, I have confirmed the duplicate and I am reversing it now.</p>
        </TimelineEvent>
      </div>
    </PreviewSection>
  );
}
