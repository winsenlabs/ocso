import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { ControlState } from '@/components/ui/control-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { KeyValue } from '@/components/ui/key-value';
import { LegendKey, LineChart } from '@/components/ui/line-chart';
import { MetricMatrix } from '@/components/ui/metric-matrix';
import { ChartCard, DayList, RailCard } from '@/components/ui/rail-card';
import { SlaTimer } from '@/components/ui/sla-timer';
import { Tile, Tiles } from '@/components/ui/tile';
import { PreviewSection } from './preview-section';

interface SampleRow {
  id: string;
  name: string;
  topic: string;
  agent: string;
}

const ROWS: SampleRow[] = [
  { id: '1', name: 'Priya Deshmukh', topic: 'duplicate EMI debit', agent: 'Maya' },
  { id: '2', name: 'Arvind Nair', topic: 'replacement card courier', agent: 'Maya' },
];

const COLUMNS: Column<SampleRow>[] = [
  { key: 'c', header: 'Customer', cell: (r) => <CellTitle title={r.name} caption={r.topic} /> },
  { key: 'a', header: 'Agent', cell: (r) => <span className="mono-sm">{r.agent}</span> },
  { key: 's', header: 'Control', cell: () => <ControlState state="human">you</ControlState> },
  { key: 't', header: 'Last turn', cell: () => <span className="mono-sm">09:56</span> },
  { key: 'l', header: 'SLA', cell: () => <SlaTimer level="risk" progress={0.78} label="04:12" /> },
];

/** Metrics, charts, tables and key/value blocks (design/02, 03, 06 samples). */
export function DataPreview() {
  return (
    <PreviewSection title="Data display">
      <Tiles>
        <Tile label="conversations" value="4,812" delta="+6.2%" />
        <Tile label="escalation rate" value="18.6%" tone="warn" />
        <Tile label="first response" value="1m 12s" />
        <Tile label="csat · no data" />
      </Tiles>
      <div className="row2">
        <ChartCard title="Latency · last 60 minutes" meta={<><LegendKey color="var(--ink)" label="turn p95" /><LegendKey color="var(--accent)" label="ttft p95" /></>}>
          <LineChart
            label="Turn and time-to-first-token p95 over the last hour; a spike at 09:40"
            height={100}
            guides={[0.34, 0.66]}
            domain={[0, 100]}
            series={[
              { label: 'turn p95', color: 'var(--ink)', values: [38, 40, 37, 42, 39, 41, 43, 40, 66, 78, 74, 56, 48] },
              { label: 'ttft p95', color: 'var(--accent)', values: [18, 20, 17, 21, 19, 20, 22, 20, 40, 52, 48, 32, 26] },
            ]}
            markers={[{ at: 8, color: 'var(--danger)' }]}
            axis={[{ text: '09:00' }, { text: '09:40 bedrock throttle', color: 'var(--danger)' }, { text: '10:00' }]}
          />
        </ChartCard>
        <ChartCard title="Token usage and cache · today">
          <MetricMatrix
            metrics={[
              { label: 'input tokens', value: '28.4M' },
              { label: 'output tokens', value: '6.1M' },
              { label: 'cache read', value: '25.9M' },
              { label: 'cache write', value: '1.4M' },
            ]}
          />
          <HBarChart
            label="Token share by model profile"
            columns="minmax(90px,1fr) minmax(0,2fr) 54px"
            rows={[
              { label: 'support-primary', share: 0.72, display: '72%', tone: 'a' },
              { label: 'support-fast', share: 0.14, display: '14%', tone: 'a' },
              { label: 'tool failure', share: 0.28, display: '99', tone: 'd' },
              { label: 'above authority', share: 0.88, display: '312', tone: 'w' },
              { label: 'first response', share: 0.82, display: '15:00', tone: 'g' },
            ]}
          />
        </ChartCard>
      </div>
      <DataTable label="Sample table" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} template="minmax(0,1.5fr) 104px 118px 92px 96px" selectedKey="2" />
      <div className="row2">
        <ChartCard title="KeyValue">
          <KeyValue
            items={[
              { k: 'neutrals', v: 'cool near-white chrome, four ink steps, hairline borders' },
              { k: 'accent', v: 'single indigo — AI surfaces and active states only' },
              { k: 'type', v: 'Inter for prose, JetBrains Mono for identifiers and metric labels' },
            ]}
          />
        </ChartCard>
        <RailCard title="Recently resolved" count="3">
          <DayList
            rows={[
              { key: 'a', time: '10:14', label: 'Priya Deshmukh', who: 'reversal ₹12,480', flag: '4.6' },
              { key: 'b', time: '09:32', label: 'Mohit Bansal', who: 'fee waiver query', flag: '4.0' },
            ]}
          />
        </RailCard>
      </div>
    </PreviewSection>
  );
}
