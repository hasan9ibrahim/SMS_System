-- Team trial round 1 answers (2026-10-18).
BEGIN;
-- 1. NOC and Support are one department (§11): Support's users, report schedules, alert recipients and
--    visibility assignment move to NOC, and Support is archived. The 'support' mailbox of a business
--    company is an address, not a department, and stays.
DO $$
DECLARE noc bigint; sup bigint;
BEGIN
  SELECT id INTO noc FROM departments WHERE name = 'NOC';
  SELECT id INTO sup FROM departments WHERE name = 'Support' AND deleted_at IS NULL;
  IF noc IS NULL OR sup IS NULL THEN RETURN; END IF;
  UPDATE users SET department_id = noc WHERE department_id = sup;
  UPDATE scheduled_reports SET team_department_id = noc WHERE team_department_id = sup;
  UPDATE alert_rules SET notify_department_ids = array(SELECT DISTINCT unnest(array_replace(notify_department_ids, sup, noc)))
   WHERE sup = ANY(notify_department_ids);
  DELETE FROM visibility_assignments a WHERE target_type = 'department' AND target_id = sup
     AND EXISTS (SELECT 1 FROM visibility_assignments b WHERE b.target_type = 'department' AND b.target_id = noc);
  UPDATE visibility_assignments SET target_id = noc WHERE target_type = 'department' AND target_id = sup;
  UPDATE departments SET deleted_at = now(), status = 'inactive' WHERE id = sup;
END $$;
-- 2. Tech info e-mails carry the SMPP password in plain text ({password}, §8).
UPDATE email_templates
   SET body = replace(body, 'The password is shared separately.', 'Password: {password}')
 WHERE email_type = 'customer_tech_info' AND body LIKE '%The password is shared separately.%';
COMMIT;
