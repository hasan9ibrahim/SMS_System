-- Never-saved New rule drafts (§6.3, §13.10, contract v0.129.0). The New rule window adds its rule at once, turned off,
-- and only the window's Save keeps it; ×, closing its tab or a reload discards it. Nothing told a draft from a rule saved
-- turned off (both are a rule added by POST and changed by PUT), so a draft left behind - the page reloaded while the
-- window was still adding it - stayed. The window now adds its rule with draft = true and Save sets it false; the
-- TypeScript service's hourly job (mock/src/jobs/routeRuleDrafts.ts) removes drafts older than 24 hours that were never
-- turned on and carried no traffic, with their vendors, whitelists, traffic rows and change history, as discard does.
-- Rules added before this column count as kept.
ALTER TABLE route_rules ADD COLUMN IF NOT EXISTS draft boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS route_rules_draft_idx ON route_rules (inserted_at) WHERE draft;
