import 'server-only';
import { notYetAvailable } from './pending';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertState = 'open' | 'acknowledged' | 'investigating' | 'resolved';

/** An alert visible to the current user's audience (docs/11 §6). */
export interface AlertRow {
  id: string;
  title: string;
  detail: string;
  severity: AlertSeverity;
  source: string;
  openedAt: string;
  state: AlertState;
}

/** Open alerts for the signed-in user's role audience, newest first. */
export function loadOpenAlerts(): Promise<AlertRow[] | null> {
  return notYetAvailable('GET /v1/alerts?state=open');
}
