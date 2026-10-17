-- Translation rules (§6.4): Regex Replace next to Translation (prefix swap), decided 2026-10-17.
-- The *_conversion_value holds the pattern, *_conversion_replacement what each match becomes.
SET search_path = sms, public;

ALTER TABLE translation_rules
  DROP CONSTRAINT translation_rules_sender_conversion_check,
  DROP CONSTRAINT translation_rules_receiver_conversion_check,
  ADD CONSTRAINT translation_rules_sender_conversion_check CHECK (sender_conversion IN
    ('left_strip','right_strip','prepend','append','translation','regex_replace','random_number','sender_id_template')),
  ADD CONSTRAINT translation_rules_receiver_conversion_check CHECK (receiver_conversion IN
    ('left_strip','right_strip','prepend','append','translation','regex_replace')),
  ADD COLUMN sender_conversion_replacement   text,
  ADD COLUMN receiver_conversion_replacement text;
