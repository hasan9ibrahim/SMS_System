defmodule Sms.Api.PasswordGate do
  @moduledoc """
  The password gate (§13.28): while the signed-in user's password is expired, temporary or must be changed, only the
  session, the password change and the shell around it work; every other call answers 403
  `password_change_required` (the GUI then shows only Change Password). The same operations stay open as in the
  mock (mock/src/admin/gate.ts); the state is kept a few seconds per user.
  """
  alias Sms.Api.Problem
  alias Sms.Core.Repo

  @open ~w(getHealth getCurrentUser getMyPasswordStatus changeMyPassword sendMyPasswordCode checkPassword
           getWorkspace saveWorkspace updatePreferences recordPageView getMyPages signIn signInCode
           resendSignInCode signOut)
  @table __MODULE__
  @ttl_ms 3_000

  @doc "`:ok`, or the 403 problem while only the password change works."
  @spec check(pos_integer(), String.t()) :: :ok | {:error, Problem.t()}
  def check(_user_id, operation_id) when operation_id in @open, do: :ok

  def check(user_id, _operation_id) do
    if blocked?(user_id),
      do:
        {:error,
         Problem.new(403, "Change your password to continue",
           detail:
             "Your password expired or must be changed. Only the Change Password screen works until then.",
           code: "password_change_required"
         )},
      else: :ok
  end

  defp blocked?(user_id) do
    _ = if :ets.whereis(@table) == :undefined, do: :ets.new(@table, [:named_table, :public, :set])

    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, user_id) do
      [{_, blocked, at}] when now - at < @ttl_ms ->
        blocked

      _ ->
        blocked = state(user_id) in ["temporary", "must_change", "expired"]
        :ets.insert(@table, {user_id, blocked, now})
        blocked
    end
  rescue
    ArgumentError -> state(user_id) in ["temporary", "must_change", "expired"]
  end

  @doc "Drops the cached states (after a password change)."
  @spec forget() :: :ok
  def forget do
    if :ets.whereis(@table) != :undefined, do: :ets.delete_all_objects(@table)
    :ok
  end

  # The mock's STATE_SQL: the lifetime comes from Admin › Security settings.
  defp state(user_id) do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT CASE WHEN u.temp_password_expires_at IS NOT NULL THEN 'temporary'
                    WHEN u.must_change_password THEN 'must_change'
                    WHEN u.password_changed_at + make_interval(days => s.password_lifetime_days) <= now()
                      THEN 'expired'
                    ELSE 'ok' END
          FROM users u CROSS JOIN (SELECT coalesce(max(password_lifetime_days), 30) AS password_lifetime_days
                                     FROM security_settings WHERE id = 1) s
         WHERE u.id = $1
        """,
        [user_id]
      )

    case rows do
      [[state]] -> state
      [] -> "ok"
    end
  end
end
