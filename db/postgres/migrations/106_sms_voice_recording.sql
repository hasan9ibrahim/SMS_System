-- SMS to voice (§8, product owner 2026-10-31): a rule may have its own recording in place of the default phrase
-- "Your verification code is"; the digits are still said after it. Stored as Asterisk plays it (WAV, mono, 8 kHz,
-- 16-bit PCM; the API converts other PCM WAVs on upload), at most 1 MB. Null: the default phrase. Add only.
ALTER TABLE sms_voice_rules ADD COLUMN IF NOT EXISTS prompt_wav bytea;
ALTER TABLE sms_voice_rules ADD COLUMN IF NOT EXISTS prompt_wav_name text;
ALTER TABLE sms_voice_rules ADD COLUMN IF NOT EXISTS prompt_wav_sha256 text;
