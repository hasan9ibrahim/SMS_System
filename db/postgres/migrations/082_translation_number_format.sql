-- Number format in translation rule content (team trial round 6, §13.2): every run of at least
-- content_number_min_digits digits (null = 6) is written out through the pattern, # = one digit.
ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS content_number_format text
  CHECK (content_number_format IS NULL OR (length(content_number_format) <= 40 AND content_number_format LIKE '%#%'));
ALTER TABLE translation_rules ADD COLUMN IF NOT EXISTS content_number_min_digits smallint
  CHECK (content_number_min_digits BETWEEN 2 AND 20);
