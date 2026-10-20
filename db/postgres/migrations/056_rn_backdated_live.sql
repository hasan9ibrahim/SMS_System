-- Back-dated RN lines that affected live traffic (team trial round 2, §13.32): a line counts when at least
-- rerate_min_messages were sent since its stated date. Only those can be re-rated on accept, and any of them
-- keeps the RN from being auto-accepted.
SET search_path = sms, public;

ALTER TABLE rn_settings ADD COLUMN IF NOT EXISTS rerate_min_messages int NOT NULL DEFAULT 1
  CHECK (rerate_min_messages BETWEEN 1 AND 1000000);
ALTER TABLE rate_notifications ADD COLUMN IF NOT EXISTS backdated_live int NOT NULL DEFAULT 0;
UPDATE rate_notifications n SET backdated_live = s.c
  FROM (SELECT rn_id, count(*)::int AS c FROM rate_notification_lines WHERE backdated AND sent_between >= 1 GROUP BY rn_id) s
 WHERE s.rn_id = n.id AND n.backdated_live = 0;

-- Credit alert is off until a non-zero credit limit is set (team trial round 2, §5.1).
ALTER TABLE enterprises ALTER COLUMN credit_alert SET DEFAULT false;
