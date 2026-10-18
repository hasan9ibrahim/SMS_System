-- Translation rules: words or phrases to replace or remove in the content (team trial round 1, §6.4, §13.2).
ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS content_words jsonb NOT NULL DEFAULT '[]';
