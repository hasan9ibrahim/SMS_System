-- Exchange-rate source: any rate API, minimum change and a daily update (team trial round 3, §7, §13.12).
-- The source is checked every refresh_minutes; a rate changes only when it moved at least min_change
-- (percent of the current rate or amount per EUR). Every day at daily_update_at (platform time zone) all
-- rates are taken from the source whatever the difference.
SET search_path = sms, public;

ALTER TABLE fx_provider DROP CONSTRAINT IF EXISTS fx_provider_provider_check;
ALTER TABLE fx_provider ADD CONSTRAINT fx_provider_provider_check
  CHECK (provider IN ('xe', 'openexchangerates', 'fixer', 'exchangerate_api', 'ecb', 'custom', 'manual'));
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS api_url text;
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'basic'
  CHECK (auth_type IN ('none', 'query', 'header', 'basic', 'path'));
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS auth_param text;
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS rates_path text;
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS base_currency char(3) NOT NULL DEFAULT 'EUR';
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS min_change_mode text NOT NULL DEFAULT 'percent'
  CHECK (min_change_mode IN ('percent', 'amount'));
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS min_change numeric(18, 8) NOT NULL DEFAULT 0.5 CHECK (min_change >= 0);
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS daily_update_at text DEFAULT '06:00'
  CHECK (daily_update_at IS NULL OR daily_update_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE fx_provider ADD COLUMN IF NOT EXISTS last_daily_at timestamptz;
UPDATE fx_provider
   SET api_url = COALESCE(api_url, 'https://xecdapi.xe.com/v1/convert_from.json?from={base}&to=*'),
       rates_path = COALESCE(rates_path, 'to')
 WHERE provider = 'xe';
