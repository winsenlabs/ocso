import Link from 'next/link';
import { comparedWith, formatTileValue, trendOf, type BetterWhen, type TileUnit } from './home-model';

export interface TrendTileInput {
  key: string;
  label: string;
  value: number | null;
  unit?: TileUnit | null | undefined;
  previous: number | null;
  betterWhen: BetterWhen;
  /** What the value covers ('today', '7d', 'now'): a 'now' value has no earlier period to compare with. */
  period?: string | null | undefined;
  href?: string | null | undefined;
}

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

/**
 * Trend tiles (HOME decision 4): value, the change vs the previous period
 * coloured by whether that direction is good, a sentence for screen readers,
 * and a link to where the number comes from.
 */
export function TrendTiles({ tiles, period, compact = false, label }: { tiles: TrendTileInput[]; period: string; compact?: boolean; label: string }) {
  if (!tiles.length) return null;
  return (
    <ul className={compact ? 'trend-tiles compact' : 'trend-tiles'} aria-label={label}>
      {tiles.map((t) => (
        <li key={t.key}>
          <TrendTile tile={t} period={period} />
        </li>
      ))}
    </ul>
  );
}

export function TrendTile({ tile, period }: { tile: TrendTileInput; period: string }) {
  const value = formatTileValue(tile.value, tile.unit);
  const trend = trendOf(tile.value, tile.previous, tile.betterWhen, tile.unit, comparedWith(tile.period, period));
  const live = tile.period === 'now';
  const body = (
    <>
      <span className="k">{tile.label}</span>
      <span className="v">{value ?? <span aria-hidden="true">—</span>}</span>
      {value === null ? (
        <span className="nd">no data yet</span>
      ) : trend.label ? (
        <span className={`tt-delta ${trend.tone}`}>
          <span aria-hidden="true">
            {ARROW[trend.direction]} {trend.label}
          </span>
          <span className="sr-only">{trend.sr}</span>
        </span>
      ) : (
        <span className="tt-delta neutral">{live ? 'right now' : 'no earlier data'}</span>
      )}
    </>
  );
  const className = value === null ? 'tile trend-tile nodata' : 'trend-tile tile';
  return tile.href ? (
    <Link className={className} href={tile.href} data-tile={tile.key}>
      {body}
    </Link>
  ) : (
    <div className={className} data-tile={tile.key}>
      {body}
    </div>
  );
}
