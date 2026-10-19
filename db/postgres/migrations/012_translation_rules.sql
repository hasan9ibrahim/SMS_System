-- Number lists and Translation rules (spec §6.4, §13.2), build step 5.3.
SET search_path = sms, public;

-- Every field of the §6.4 form that the first schema did not hold.
ALTER TABLE translation_rules
  ADD COLUMN continue_after            boolean NOT NULL DEFAULT true,   -- Is Continue (a trunk can override)
  ADD COLUMN mccmnc_negate             boolean NOT NULL DEFAULT false,
  ADD COLUMN content_pattern_negate    boolean NOT NULL DEFAULT false,
  ADD COLUMN sender_list_negate        boolean NOT NULL DEFAULT false,
  ADD COLUMN receiver_list_negate      boolean NOT NULL DEFAULT false,
  -- Random / Sender ID Template list a sender conversion picks from (sender_list_id is a match list).
  ADD COLUMN sender_conversion_list_id bigint REFERENCES number_lists(id),
  -- Content rewrite: Regex + Regex Index + Message Text, or a whole MSG Template ({text} = original).
  ADD COLUMN content_regex             text,
  ADD COLUMN content_regex_index       smallint CHECK (content_regex_index BETWEEN 1 AND 5),
  ADD COLUMN content_replacement       text,
  ADD COLUMN msg_template              text,
  -- Where the rule runs on trunks that have no position for it; copied to its targets on save.
  ADD COLUMN insert_at                 text NOT NULL DEFAULT 'bottom' CHECK (insert_at IN ('top','bottom'));

UPDATE translation_rules r SET insert_at = 'top'
 WHERE EXISTS (SELECT 1 FROM translation_rule_targets t WHERE t.translation_rule_id = r.id AND t.insert_at = 'top');

UPDATE translation_rules
   SET sender_conversion_list_id = sender_list_id, sender_list_id = NULL
 WHERE sender_conversion IN ('random_number','sender_id_template') AND sender_list_id IS NOT NULL;

-- DLR Status & Error Code Convert: an ordered list of {fromStatus, fromError, toStatus, toError}.
UPDATE translation_rules
   SET dlr_status_map = (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                  'fromStatus', key, 'fromError', NULL, 'toStatus', value #>> '{}', 'toError', NULL)), '[]')
                           FROM jsonb_each(dlr_status_map))
 WHERE jsonb_typeof(dlr_status_map) = 'object';
UPDATE translation_rules SET dlr_status_map = '[]' WHERE dlr_status_map IS NULL;
ALTER TABLE translation_rules
  ALTER COLUMN dlr_status_map SET DEFAULT '[]',
  ALTER COLUMN dlr_status_map SET NOT NULL;

-- Entries are archived on delete (undo restores them) and unique per list among live rows.
ALTER TABLE number_list_entries ADD COLUMN deleted_at timestamptz;
UPDATE number_list_entries e SET deleted_at = now()
  FROM (SELECT id, row_number() OVER (PARTITION BY number_list_id, value ORDER BY id) AS n FROM number_list_entries) d
 WHERE d.id = e.id AND d.n > 1;
CREATE UNIQUE INDEX number_list_entries_live_uq ON number_list_entries(number_list_id, value) WHERE deleted_at IS NULL;
