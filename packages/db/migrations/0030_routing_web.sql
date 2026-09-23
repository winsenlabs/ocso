-- 0030_routing_web (PM/research/11 wave 2, ROUTING-WEB). Hand-written; never run drizzle-kit generate.
-- Routers, queues and SLA policies take part in maker–checker through approval_proposals (0023): approval
-- state is derived from that table, so no column is added to the routing tables. Two lookups the approval
-- descriptors and the router screens run per router get indexes: a router's channels (list, detach, reach)
-- and a router's conversations (delete blockers, routing history). The tables are small at this point, so
-- plain CREATE INDEX (the runner wraps the file in a transaction; no CONCURRENTLY).
CREATE INDEX IF NOT EXISTS "channels_router_idx" ON "channels" USING btree ("router_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_routing_router_idx" ON "conversation_routing" USING btree ("router_id");
