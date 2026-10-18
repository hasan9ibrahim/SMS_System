-- Split per customer trunk is the default for percentage rules (team trial round 1, §6.3).
BEGIN;
ALTER TABLE route_rules ALTER COLUMN percentage_per_customer_trunk SET DEFAULT true;
UPDATE route_rules SET percentage_per_customer_trunk = true WHERE NOT percentage_per_customer_trunk;
COMMIT;
