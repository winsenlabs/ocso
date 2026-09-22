-- A channel routes to exactly one agent (an agent may answer on many channels). Existing rows are
-- reconciled first: the channel's own default agent wins; otherwise the lowest agent id keeps it.
DELETE FROM agent_channels a
 USING channels c
 WHERE a.channel_id = c.id
   AND c.default_agent_id IS NOT NULL
   AND a.agent_id <> c.default_agent_id;--> statement-breakpoint
DELETE FROM agent_channels a
 WHERE a.agent_id::text <> (SELECT min(b.agent_id::text) FROM agent_channels b WHERE b.channel_id = a.channel_id);--> statement-breakpoint
-- Keep the two records of the same fact in step: a channel attached to an agent routes to it.
UPDATE channels c
   SET default_agent_id = a.agent_id, updated_at = now()
  FROM agent_channels a
 WHERE a.channel_id = c.id
   AND c.default_agent_id IS DISTINCT FROM a.agent_id;--> statement-breakpoint
INSERT INTO agent_channels (agent_id, channel_id)
SELECT c.default_agent_id, c.id FROM channels c
 WHERE c.default_agent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agent_channels a WHERE a.channel_id = c.id);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_channels_channel_uq" ON "agent_channels" USING btree ("channel_id");