/**
 * Claim queries for the `jobs` table. Parameters: $1 topic, $2 max rows,
 * $3 worker id, $4 visibility timeout seconds. A running job whose
 * `locked_until` passed is redelivered (its worker died or stalled).
 */
const CLAIMABLE = `j.topic = $1 AND (
      (j.status = 'queued' AND j.available_at <= now())
   OR (j.status = 'running' AND j.locked_until < now()))`;

const UPDATE_CLAIMED = `UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, locked_by = $3,
         locked_until = now() + make_interval(secs => $4)
    FROM candidate WHERE jobs.id = candidate.id
  RETURNING jobs.id, jobs.topic, jobs.payload, jobs.group_key, jobs.attempts, jobs.enqueued_at`;

export const CLAIM_SQL = `WITH candidate AS (
  SELECT j.id FROM jobs j
   WHERE ${CLAIMABLE}
   ORDER BY j.available_at
   LIMIT $2
   FOR UPDATE OF j SKIP LOCKED)
${UPDATE_CLAIMED}`;

/**
 * Conversation affinity (ADR-008): skip groups busy on another live worker;
 * prefer groups whose lease this worker already holds (warm context).
 */
export const CLAIM_WITH_AFFINITY_SQL = `WITH candidate AS (
  SELECT j.id FROM jobs j
   WHERE ${CLAIMABLE}
     AND NOT EXISTS (
       SELECT 1 FROM conversation_leases l
        WHERE l.conversation_id::text = j.group_key
          AND l.worker_id <> $3 AND l.busy AND l.expires_at > now())
   ORDER BY EXISTS (
       SELECT 1 FROM conversation_leases l
        WHERE l.conversation_id::text = j.group_key
          AND l.worker_id = $3 AND l.expires_at > now()) DESC,
     j.available_at
   LIMIT $2
   FOR UPDATE OF j SKIP LOCKED)
${UPDATE_CLAIMED}`;
