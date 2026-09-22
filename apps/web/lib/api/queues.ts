import 'server-only';
import { notYetAvailable } from './pending';

export interface QueueSummary {
  id: string;
  name: string;
  waiting: number;
  onShift: number;
  capacity: number;
  avgWaitSeconds: number;
  breaches: number;
  state: 'ok' | 'watch' | 'understaffed';
}

export function loadQueueSummaries(): Promise<QueueSummary[] | null> {
  return notYetAvailable('GET /v1/queues?include=live');
}
