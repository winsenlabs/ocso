-- Web chat verified user ids are scoped to the channel that verified them (SPEC §C, review finding "scope verified
-- web chat user ids per channel"). From this release a `webchat_customer_ref` identity value is
-- `<channel id>:<sub>`: two web chat channels whose sites issue the same `sub` no longer share a customer, and
-- customer claims present the `sub` to tools only on the verifying channel's conversations. No schema change.
--
-- Existing rows hold the bare `sub`. Each is rewritten to its channel's form when the channel is known from the
-- customer's web chat history: their conversations and held user tokens are all on exactly one web chat channel.
-- Rows whose channel cannot be told (no web chat conversation, or several web chat channels, which is exactly the
-- ambiguous case) are left as they are: nothing matches them any more, so that user starts a new customer on
-- their next session, and staff can still see the old identity on the old customer.
UPDATE customer_identities ci
   SET value = src.channel_id || ':' || ci.value
  FROM (
    SELECT customer_id, min(channel_id) AS channel_id
      FROM (
        SELECT c.customer_id, c.channel_id::text AS channel_id
          FROM conversations c JOIN channels ch ON ch.id = c.channel_id
         WHERE ch.kind = 'WEBCHAT'
        UNION
        SELECT t.customer_id, t.channel_id::text
          FROM webchat_user_tokens t
      ) seen
     GROUP BY customer_id
    HAVING count(DISTINCT channel_id) = 1
  ) src
 WHERE ci.kind = 'webchat_customer_ref'
   AND ci.customer_id = src.customer_id
   AND NOT EXISTS (SELECT 1 FROM channels x WHERE starts_with(ci.value, x.id::text || ':'));
