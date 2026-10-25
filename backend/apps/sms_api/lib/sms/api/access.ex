defmodule Sms.Api.Access do
  @moduledoc """
  The server-side check of the user's GUI Access Group (§1, §11; backend step 9, product owner 2026-10-25): every
  change is checked; reads stay open, so pickers on other pages keep working; Admin pages need View even to read
  (`Sms.Api.Operations`). Administrators may do everything. AM visibility (§13.17) still masks and hides data on top.

  The user's pages and actions are the group's, with the user's own overrides on top (an empty list = no access to
  that page, which also beats the group's every-page grant `*`), as the mock computes them
  (mock/src/admin/catalog.ts effectiveAccess). Read from the database and kept for a few seconds per user.
  """
  alias Sms.Api.{Operations, Problem}
  alias Sms.Core.Repo

  @table __MODULE__
  @ttl_ms 5_000

  @doc "Whether the user may call the operation; a 403 problem if not."
  @spec check(pos_integer(), Operations.t()) :: :ok | {:error, Problem.t()}
  def check(_user_id, %{module: nil}), do: :ok
  def check(_user_id, %{action: nil, read_checked: false}), do: :ok

  def check(user_id, %{module: page, action: action}) do
    action = action || "view"

    if allowed?(of(user_id), page, action),
      do: :ok,
      else:
        {:error,
         Problem.new(403, "Your access group does not allow this",
           detail: "#{action} on #{page} is not given to your user. Ask an administrator.",
           code: "not_allowed"
         )}
  end

  @doc false
  @spec allowed?(map(), String.t(), String.t()) :: boolean()
  def allowed?(%{admin: true}, _page, _action), do: true

  def allowed?(%{permissions: perms, denied: denied}, page, action) do
    page not in denied and action in (Map.get(perms, page) || Map.get(perms, "*") || [])
  end

  @doc false
  # The effective access of a group's pages and the user's overrides (mock/src/admin/catalog.ts effectiveAccess).
  @spec effective(map(), map()) :: %{permissions: map(), denied: [String.t()]}
  def effective(group, overrides) do
    Enum.reduce(overrides, %{permissions: group, denied: []}, fn
      {page, []}, acc ->
        %{acc | permissions: Map.delete(acc.permissions, page), denied: [page | acc.denied]}

      {page, actions}, acc ->
        %{acc | permissions: Map.put(acc.permissions, page, actions)}
    end)
  end

  @doc "Drops the cached access of every user (after a change to users or access groups)."
  @spec forget() :: :ok
  def forget do
    if :ets.whereis(@table) != :undefined, do: :ets.delete_all_objects(@table)
    :ok
  end

  defp of(user_id) do
    ensure_table()
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, user_id) do
      [{_, access, at}] when now - at < @ttl_ms ->
        access

      _ ->
        access = load(user_id)
        :ets.insert(@table, {user_id, access, now})
        access
    end
  end

  defp load(user_id) do
    %{rows: rows} =
      Repo.query!(
        """
        SELECT u.is_admin, coalesce(g.permissions, '{}'::jsonb), u.permission_overrides
          FROM users u LEFT JOIN access_groups g ON g.id = u.access_group_id
         WHERE u.id = $1
        """,
        [user_id]
      )

    case rows do
      [[true, _, _]] -> %{admin: true}
      [[_, group, overrides]] -> Map.put(effective(group || %{}, overrides || %{}), :admin, false)
      [] -> %{admin: false, permissions: %{}, denied: []}
    end
  end

  defp ensure_table do
    _ =
      if :ets.whereis(@table) == :undefined,
        do: :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])

    :ok
  rescue
    ArgumentError -> :ok
  end
end
