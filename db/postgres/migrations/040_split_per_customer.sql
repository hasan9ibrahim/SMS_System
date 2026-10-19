-- Team trial round 1 (§6.3): "Consider customer trunk in percentage" - with a percentage split, each customer
-- trunk's own traffic is split by the shares, instead of the rule's total traffic.
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS percentage_per_customer_trunk boolean NOT NULL DEFAULT false;
