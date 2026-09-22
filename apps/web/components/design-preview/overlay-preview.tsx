'use client';

import { useState } from 'react';
import { AgentPortrait } from '@/components/ui/brand-mark';
import { Drawer } from '@/components/ui/drawer';
import { Modal } from '@/components/ui/modal';
import { Stepper } from '@/components/ui/stepper';
import { PreviewSection, Row } from './preview-section';

const STEPS = ['Enter URL', 'Discover server', 'Authenticate', 'Review capabilities', 'Approve', 'Active'].map((label) => ({ label }));

/** Modal (with Stepper) and Drawer, opened on demand. */
export function OverlayPreview() {
  const [open, setOpen] = useState<'modal' | 'drawer' | null>(null);
  const [step, setStep] = useState(0);
  const close = () => setOpen(null);
  return (
    <PreviewSection title="Overlays" note="Escape closes; Tab stays inside the modal">
      <Row>
        <button type="button" className="btn" onClick={() => setOpen('modal')}>
          Open modal + stepper
        </button>
        <button type="button" className="btn" onClick={() => setOpen('drawer')}>
          Open drawer
        </button>
        <Stepper label="Standalone stepper, failed step" steps={STEPS.slice(0, 4)} current={2} failed={2} />
      </Row>
      {open === 'modal' ? (
        <Modal
          title="Add MCP server"
          sub={`Step ${step + 1} of 6`}
          onClose={close}
          maxWidth={740}
          flush
          footer={
            <>
              <span className="mono-sm">OCSO fetches the manifest only</span>
              <span className="sp" />
              <button type="button" className="btn ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                Back
              </button>
              <button type="button" className="btn accent" onClick={() => setStep((s) => Math.min(5, s + 1))}>
                Continue
              </button>
            </>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: '184px minmax(0,1fr)' }}>
            <div style={{ borderRight: '1px solid var(--border)', background: 'var(--bg-2)', padding: '16px 14px' }}>
              <Stepper label="Add MCP server steps" steps={STEPS} current={step} />
            </div>
            <div style={{ padding: 18, display: 'grid', gap: 14, alignContent: 'start' }}>
              <div className="fld">
                <label htmlFor="demo-url">MCP server URL</label>
                <input id="demo-url" type="text" defaultValue="https://mcp.example.internal/loans" />
                <span className="hint">https or streamable http</span>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
      {open === 'drawer' ? (
        <Drawer title="Ask OCSO" sub="scope · platform · ap-south-1" icon={<AgentPortrait background="var(--accent)" />} onClose={close} footer={<span className="mono-sm">footer slot</span>}>
          <div className="denied">Drawer body. Press Escape to close.</div>
        </Drawer>
      ) : null}
    </PreviewSection>
  );
}
