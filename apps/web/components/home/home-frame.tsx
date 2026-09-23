import type { ReactNode } from 'react';
import type { SetupData, TrendTileData } from '@/lib/api/home';
import { AskOcsoBar, type AskChip } from './ask-ocso-bar';
import { Greeting } from './greeting';
import type { NeedsYouLike } from './home-model';
import { NeedsYou } from './needs-you';
import { SetupChecklist } from './setup-checklist';
import { TrendTiles } from './trend-tiles';

export interface HomeFrameProps {
  name: string;
  tail: string;
  strip: string[];
  /** Ask OCSO chips; null hides the bar (not configured, or the role cannot use it). */
  ask: AskChip[] | null;
  needsYou: NeedsYouLike[];
  tiles: TrendTileData[];
  period: string;
  setup: SetupData | null | undefined;
  /** The viewer's permissions: setup steps they cannot do read "waiting on <role>". */
  permissions: ReadonlySet<string>;
  /** Between the greeting and "needs you" (Tech: the health strip). */
  lead?: ReactNode;
  /** Under the tiles in the rail beside "needs you". */
  rail?: ReactNode;
  now: Date;
  children: ReactNode;
}

/**
 * The shape every role Home shares (HOME contract): greeting, Ask OCSO, then
 * "needs you" first with the trend tiles beside it — or, on a deployment still
 * being set up, the checklist in their place — then the role's own body.
 */
export function HomeFrame({ name, tail, strip, ask, needsYou, tiles, period, setup, permissions, lead, rail, now, children }: HomeFrameProps) {
  const settingUp = Boolean(setup && !setup.complete && setup.steps.length);
  return (
    <div className="home">
      <Greeting name={name} tail={tail} strip={strip} />
      {ask ? <AskOcsoBar chips={ask} /> : null}
      {lead}
      <div className="row2 home-top">
        <NeedsYou items={needsYou} canAsk={ask !== null} now={now} />
        <div className="rail">
          {settingUp && setup ? <SetupChecklist steps={setup.steps} permissions={permissions} /> : <TrendTiles tiles={tiles} period={period} compact label={`Key numbers vs ${period}`} />}
          {rail}
        </div>
      </div>
      {children}
    </div>
  );
}
