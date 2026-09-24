-- Channel reply context (Slack and Microsoft Teams channels): where replies to an inbound customer message go, in
-- the channel adapter's own terms (a Slack channel + thread, a Bot Framework conversation reference). Opaque to core:
-- written from InboundMessage.replyContext on inbound interactions, read back by delivery for the conversation's
-- next outbound messages (OutboundTarget.replyContext). Null for every other row and for earlier messages.
ALTER TABLE "interactions" ADD COLUMN "reply_context" jsonb;
