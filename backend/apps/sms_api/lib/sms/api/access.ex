defmodule Sms.Api.Access do
  @moduledoc """
  The server-side check of the user's GUI Access Group (§1, §11). Product owner 2026-10-25 (backend step 10): every
  call is checked, reads too (a read needs the page's View, a change its action), so a page the user may not open is
  not reached from another page either; other pages pick its records by name through `/lookups`. Admin pages are for
  administrators only, unless the group or the user's own override names that page itself: the group's Every page
  grant (`*`) never covers them. Administrators may do everything. AM visibility (§13.17) still masks and hides data
  on top.

  The user's pages and actions are the group's, with the user's own overrides on top (an empty list = no access to
  that page, which also beats the group's every-page grant `*`), as the mock computes them
  (mock/src/admin/catalog.ts effectiveAccess). Read from the database and kept for a few seconds per user.
  """
  alias Sms.Api.{Caches, Operations, Problem}
  alias Sms.Core.Repo

  @table __MODULE__
  @ttl_ms 5_000

  @access_file Path.expand("../../../../../../contract/access.json", __DIR__)
  @external_resource @access_file
  @access @access_file |> File.read!() |> Jason.decode!()
  @admin_pages @access["admin"]
  # Lookup list -> the pages that pick from it, with the list's own page (Sms.Api.Lookups has the fields).
  @lookups Map.new(@access["lookups"], fn {list, l} -> {list, l["pages"]} end)

  @doc "Whether the user may call the operation; a 403 problem if not."
  @spec check(pos_integer(), Operations.t()) :: :ok | {:error, Problem.t()}
  def check(_user_id, %{module: nil}), do: :ok
  def check(_user_id, %{action: nil, read_checked: false}), do: :ok

  def check(user_id, %{module: page, action: action} = op) do
    action = action || "view"
    access = of(user_id)

    # A page that makes the call as part of its own job (contract/access.json shared) allows it too.
    also =
      Enum.any?(Map.get(op, :also_on, []), fn a ->
        allowed?(access, a.module, a.action || "view", a.module in @admin_pages)
      end)

    if also or allowed?(access, page, action, Map.get(op, :admin, false)),
      do: :ok,
      else: {:error, not_allowed("#{action} on #{page}")}
  end

  @doc """
  Whether the user may pick records of `list` by name (`POST /lookups/{list}/query`): the list's own page, or a page
  that picks from it (contract/access.json lookups; `*` = every signed-in user).
  """
  @spec check_lookup(pos_integer(), String.t()) :: :ok | {:error, Problem.t()}
  def check_lookup(user_id, list) do
    access = of(user_id)

    case Map.fetch(@lookups, list) do
      {:ok, pages} ->
        pages = own_page(list) ++ pages

        if "*" in pages or Enum.any?(pages, &allowed?(access, &1, "view", &1 in @admin_pages)),
          do: :ok,
          else: {:error, not_allowed("picking from #{list}")}

      :error ->
        {:error, Problem.new(404, "No such lookup", detail: "#{list} has no lookup.")}
    end
  end

  # The list's own page: the page of its POST /{list}/query.
  defp own_page(list) do
    case Operations.find("POST", "/#{String.replace(list, "_", "-")}/query") do
      %{module: page} when is_binary(page) -> [page]
      _ -> []
    end
  end

  defp not_allowed(what),
    do:
      Problem.new(403, "Your access group does not allow this",
        detail: "#{what} is not given to your user. Ask an administrator.",
        code: "not_allowed"
      )

  @doc "Whether the access allows the action on the page; `admin_page` = an Admin page (never by `*`)."
  @spec allowed?(map(), String.t(), String.t(), boolean()) :: boolean()
  def allowed?(access, page, action, admin_page \\ false)
  def allowed?(%{admin: true}, _page, _action, _admin_page), do: true

  def allowed?(%{permissions: perms, denied: denied}, page, action, admin_page) do
    every = if admin_page, do: nil, else: Map.get(perms, "*")
    page not in denied and action in (Map.get(perms, page) || every || [])
  end

  @doc "Whether the user may open the page (View), for lookups and mixed answers."
  @spec can_view?(pos_integer(), String.t(), boolean()) :: boolean()
  def can_view?(user_id, page, admin_page \\ false),
    do: allowed?(of(user_id), page, "view", admin_page)

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
    now = System.monotonic_time(:millisecond)

    case Caches.ready?(@table) and :ets.lookup(@table, user_id) do
      [{_, access, at}] when now - at < @ttl_ms ->
        access

      false ->
        load(user_id)

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
end
