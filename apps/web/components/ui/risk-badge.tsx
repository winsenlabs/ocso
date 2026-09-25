/** Tool side-effect class (docs/archive/specs/08): read, write, or two-step (human confirmation). */
export type ToolRisk = 'read' | 'write' | '2-step';

const CLASS: Record<ToolRisk, string> = { read: 'r', write: 'w', '2-step': 's' };
const TITLE: Record<ToolRisk, string> = {
  read: 'Read-only tool',
  write: 'Writes to an external system',
  '2-step': 'Sensitive — requires human confirmation',
};

export function RiskBadge({ risk }: { risk: ToolRisk }) {
  return (
    <span className={`risk ${CLASS[risk]}`} title={TITLE[risk]}>
      {risk}
    </span>
  );
}
