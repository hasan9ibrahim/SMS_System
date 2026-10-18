-- Team trial round 1 (§6.4): a Sender ID template entry is a Sender ID and a content template. The message
-- gets our Sender ID and our text, with the code taken from the original text ({code}) or the text itself ({text}).
ALTER TABLE number_list_entries ADD COLUMN IF NOT EXISTS content text;
DROP INDEX IF EXISTS number_list_entries_live_uq;
CREATE UNIQUE INDEX number_list_entries_live_uq ON number_list_entries (number_list_id, value, coalesce(content, ''))
  WHERE deleted_at IS NULL;
COMMENT ON COLUMN number_list_entries.content IS 'Sender ID template lists only: the message text template; {code} = code from the original text, {text} = the original text.';
