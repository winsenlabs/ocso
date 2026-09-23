import { describe, expect, it } from 'vitest';
import { countSla, liveSla, rankBySla } from '../../../components/queues/sla-live';

const T0 = Date.parse('2026-09-22T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const waiting = (dueIn: number, since = 0) => ({ controlState: 'WAITING_FOR_HUMAN', waitingSince: at(since), slaDueAt: at(dueIn) });

describe('live pickup SLA', () => {
  it('is ok before the at-risk fraction of the window', () => {
    expect(liveSla(waiting(300), 0.75, T0 + 60_000)).toEqual({ level: 'ok', remainingSeconds: 240, progress: 0.2 });
  });

  it('uses the queue policy fraction for at risk', () => {
    expect(liveSla(waiting(300), 0.75, T0 + 240_000).level).toBe('risk');
    expect(liveSla(waiting(300), 0.9, T0 + 240_000).level).toBe('ok');
  });

  it('breaches once past the due time, with negative remaining seconds', () => {
    const s = liveSla(waiting(300), 0.75, T0 + 400_000);
    expect(s.level).toBe('breach');
    expect(s.remainingSeconds).toBe(-100);
    expect(s.progress).toBe(1);
  });

  it('has no clock when not waiting or without a due time', () => {
    expect(liveSla({ controlState: 'HUMAN_ACTIVE', waitingSince: at(0), slaDueAt: at(300) }, 0.75, T0).level).toBe('none');
    expect(liveSla({ controlState: 'ESCALATION_REQUESTED', waitingSince: at(0), slaDueAt: null }, 0.75, T0)).toEqual({ level: 'none', remainingSeconds: null, progress: null });
  });

  it('ranks breached, then at risk, then by time left, clockless last; and counts them', () => {
    const now = T0 + 250_000;
    const rows = [
      { id: 'none', sla: liveSla({ controlState: 'WAITING_FOR_HUMAN', waitingSince: at(0), slaDueAt: null }, 0.75, now) },
      { id: 'ok-late', sla: liveSla(waiting(3_000), 0.75, now) },
      { id: 'breach', sla: liveSla(waiting(200), 0.75, now) },
      { id: 'risk', sla: liveSla(waiting(300), 0.75, now) },
      { id: 'ok-soon', sla: liveSla(waiting(1_000), 0.75, now) },
    ];
    expect(rankBySla(rows).map((r) => r.id)).toEqual(['breach', 'risk', 'ok-soon', 'ok-late', 'none']);
    expect(countSla(rows)).toEqual({ waiting: 5, withSla: 4, risk: 1, breach: 1 });
  });
});
