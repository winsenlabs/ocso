import 'server-only';
import { z } from 'zod';
import { api } from './client';

/** Storage growth (PM/research/11 §7): GET /v1/system/storage (system.read). Sizes and counts only. */

const n = z.number().nullable();

export const StorageReportSchema = z.object({
  sampledDay: z.string().nullable(),
  sampledAt: z.string().nullable(),
  database: z.object({ bytes: z.number(), tables: z.number(), bytes7d: n, bytes30d: n, bytesPerDay: n }),
  series: z.array(z.object({ day: z.string(), bytes: z.number() })),
  tables: z.array(z.object({ table: z.string(), rows: z.number(), bytes: n, rows7d: n, bytes7d: n, rows30d: n, bytes30d: n, bytesPerDay: n })),
  auditStore: z.object({ driver: z.string(), rows: n, bytes: n, rowsPerDay: n, bytesPerDay: n, sampledDay: z.string().nullable() }),
  guidance: z.object({
    level: z.enum(['ok', 'consider', 'recommend', 'columnar']),
    driver: z.string(),
    reasons: z.array(z.string()),
    thresholds: z.object({
      rows: z.object({ consider: z.number(), recommend: z.number() }),
      bytes: z.object({ consider: z.number(), recommend: z.number() }),
      eventsPerDay: z.object({ consider: z.number(), recommend: z.number() }),
      horizonDays: z.number(),
    }),
  }),
});
export type StorageReport = z.infer<typeof StorageReportSchema>;

export const loadStorageReport = () => api.get('/v1/system/storage', StorageReportSchema);
