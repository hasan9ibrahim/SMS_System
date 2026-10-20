-- Team trial round 2, group D: hidden tabs per access group and per-user overrides (§11), the AM handover
-- e-mail (§13.30), custom warm-up reset periods (§13.27).
ALTER TABLE access_groups ADD COLUMN IF NOT EXISTS hidden_tabs text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_overrides jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS tab_overrides jsonb NOT NULL DEFAULT '{}';

ALTER TABLE route_rule_vendors ADD COLUMN IF NOT EXISTS warmup_reset_hours integer
  CHECK (warmup_reset_hours BETWEEN 1 AND 8760);
ALTER TABLE route_rule_vendors DROP CONSTRAINT IF EXISTS route_rule_vendors_warmup_reset_check;
ALTER TABLE route_rule_vendors ADD CONSTRAINT route_rule_vendors_warmup_reset_check
  CHECK (warmup_reset IN ('hour', 'day', 'week', 'custom'));

ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_email_type_check;
ALTER TABLE email_templates ADD CONSTRAINT email_templates_email_type_check CHECK (email_type IN ('customer_rate',
  'invoice', 'low_balance', 'bind_down', 'customer_tech_info', 'trunk_change_info', 'soa_statement',
  'rate_upload_notification', 'traffic_alert', 'auto_upload_rejected', 'trouble_ticket', 'send_soa', 'monitoring_alert',
  'am_handover'));
ALTER TABLE email_logs DROP CONSTRAINT IF EXISTS email_logs_email_type_check;
ALTER TABLE email_logs ADD CONSTRAINT email_logs_email_type_check CHECK (email_type IN ('send_rate','send_tech_info','invoice',
  'check_smtp','bind_down_alert','otp','forgot_password','auto_upload_rate','credit_alert','balance_alert','schedule_report_alert',
  'traffic_alert','auto_upload_rejected','daily_report','broadcast','trouble_ticket','send_soa','payment_confirmation',
  'invoice_acceptance','invoice_rejection','monitoring_alert','cleanup_summary','credential_transfer','password_reminder',
  'template_test','currency_alert','am_handover'));

-- The shared AM handover template (every business company uses it until it has its own).
INSERT INTO email_templates (business_company_id, name, email_type, subject, body)
SELECT NULL, 'AM handover – standard', 'am_handover', 'Your new account manager at {company}',
       'Dear {enterprise},' || E'\n\n' ||
       'From {effective_date}, {new_am} is your account manager at {company}, taking over from {old_am}.' || E'\n\n' ||
       'You can reach {new_am} at {new_am_email}{new_am_phone_line}. Your rates, trunks and invoices do not change.' ||
       E'\n\n' || '{note}' || E'\n\n' || 'Kind regards,' || E'\n' || '{company}'
 WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE email_type = 'am_handover' AND deleted_at IS NULL);
