-- Route rule and trunk decisions R2, R4, R5, R6 (product owner, 2026-10-24; spec §5.4, §6.3, §13.28).
SET search_path = sms, public;

-- R4: route rule groups and NEXT are removed. NEXT behaved as "go on" when the rule had no usable vendor, so it
-- becomes YES.
UPDATE route_rules SET continue_routing = 'yes' WHERE continue_routing = 'next';
ALTER TABLE route_rules DROP CONSTRAINT IF EXISTS route_rules_continue_routing_check;
ALTER TABLE route_rules ADD CONSTRAINT route_rules_continue_routing_check CHECK (continue_routing IN ('yes', 'stop'));
ALTER TABLE route_rules DROP COLUMN IF EXISTS route_rule_group_id;
ALTER TABLE route_rules DROP COLUMN IF EXISTS next_route_rule_group_id;
-- Only the platform's own schema (the first on the search path); never a same-named table further down the path.
DO $$
BEGIN
  IF to_regclass(format('%I.route_rule_groups', current_schema())) IS NOT NULL THEN
    EXECUTE format('DROP TABLE %I.route_rule_groups', current_schema());
  END IF;
END $$;

-- R2: sender / receiver number lists can be negated (Not match), as the spec's Match / Not match.
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS sender_list_negate boolean NOT NULL DEFAULT false;
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS receiver_list_negate boolean NOT NULL DEFAULT false;

-- R5: the express margin is a % per message (it was an amount). Old amounts are meaningless as a %, so they reset to
-- 10 % (fake data only; real trunks arrive through the Migration Center with the % already).
ALTER TABLE customer_trunks DROP CONSTRAINT IF EXISTS customer_trunks_express_margin_check;
UPDATE customer_trunks SET express_margin = 10 WHERE express_margin IS NOT NULL AND express_margin < 1;
ALTER TABLE customer_trunks ADD CONSTRAINT customer_trunks_express_margin_check
  CHECK (express_margin IS NULL OR express_margin BETWEEN 0 AND 1000);

-- R6: a code is always needed to change a password; users without an authenticator app get one by e-mail.
-- Only a hash is stored; it lasts 10 minutes and 5 tries.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_code_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_code_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_code_sent_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_code_tries smallint NOT NULL DEFAULT 0;
