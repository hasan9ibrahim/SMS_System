defmodule Sms.Core.Repo do
  @moduledoc """
  The configuration database (PostgreSQL). It uses the schema the mock server and the screens use today
  (`db/postgres/migrations`, search path `sms,public`), so the backend can replace the mock without data changes.
  """
  use Ecto.Repo, otp_app: :sms_core, adapter: Ecto.Adapters.Postgres
end
