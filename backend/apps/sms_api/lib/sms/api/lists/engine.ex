defmodule Sms.Api.Lists.Engine do
  @moduledoc """
  The server-side list engine (CLAUDE.md rule 3, spec §13.25, §14.2), ported from the mock's
  (mock/src/lists/engine.ts): a checked `ListQuery` (filter tree with AND/OR groups, quick search, sort, cursor)
  becomes one parameterised SQL page and one count, so lists never load all rows in the browser.

    * Per field type: numbers and times compare as such (integer fields as bigint, so ID filters use their indexes);
      text compares case-insensitively; `like` takes `%` and `_` as typed; `regex` is a case-insensitive POSIX regex.
    * Quick search: plain text matches anywhere (or the start of a value on lists of named records); `%` and `_` as
      typed; a neutral id ("#123") anywhere.
    * Sort: the query's keys or the list's default, nulls last, then the list's id so pages never repeat or skip.
    * Paging: `limit` rows (100 by default) from the opaque cursor's position; one row more tells if there is a next
      page. `withTotal: false` skips the count.

  A list definition (`t:definition/0`) names its catalogue, FROM clause, SQL per field, quick-search fields, id,
  SELECT list and row mapping, like the mock's ListDef. AM visibility rules (§13.17) on columns are not ported yet:
  lists that carry them stay on the mock until they are.
  """
  alias Sms.Api.Lists.{Catalog, Query}
  alias Sms.Core.Repo

  @numeric ~w(integer decimal money percent)
  @time ~w(date datetime)

  @type definition :: %{
          required(:list) => String.t(),
          required(:from) => String.t(),
          required(:columns) => %{String.t() => String.t()},
          required(:search) => [String.t()],
          required(:id_sql) => String.t(),
          required(:select) => String.t(),
          required(:map_row) => (map() -> map()),
          optional(:base_where) => String.t(),
          optional(:archived_field) => String.t(),
          optional(:search_prefix) => boolean()
        }

  @doc "Runs a query on a list: `{:ok, page}`, or `{:error, errors}` when the query does not fit the catalogue."
  @spec run(definition(), map()) :: {:ok, map()} | {:error, [Query.error()]}
  def run(def, query) do
    catalog = Catalog.fields(def.list)

    case Query.errors(query, catalog) do
      [] -> {:ok, page(def, catalog, query)}
      errors -> {:error, errors}
    end
  end

  defp page(def, catalog, query) do
    q = compile(def, catalog, query)
    # The count runs beside the page, on another connection.
    count =
      if query["withTotal"] != false,
        do: Task.async(fn -> Repo.query!(q.count_sql, q.count_values) end)

    %{columns: cols, rows: rows} = Repo.query!(q.sql, q.values)
    more = length(rows) > q.limit

    mapped =
      rows
      |> Enum.take(q.limit)
      |> Enum.map(fn row -> cols |> Enum.zip(row) |> Map.new() |> def.map_row.() end)

    {total, estimate} =
      case count do
        nil ->
          {q.offset + length(mapped) + if(more, do: 1, else: 0), true}

        task ->
          %{rows: [[n]]} = Task.await(task, 60_000)
          {n, false}
      end

    %{
      rows: mapped,
      total: total,
      totalIsEstimate: estimate,
      nextCursor: if(more, do: encode_cursor(q.offset + q.limit))
    }
  end

  @doc false
  # The page and count statements of a checked query (public for tests).
  @spec compile(definition(), map(), map()) :: map()
  def compile(def, catalog, query) do
    by_name = Map.new(catalog["fields"], &{&1["field"], &1})
    {where, params} = where(def, by_name, query)
    where_sql = if where == [], do: "", else: "WHERE " <> Enum.join(where, " AND ")
    sort = if query["sort"] in [nil, []], do: catalog["defaultSort"], else: query["sort"]
    first_dir = sort |> List.first(%{}) |> Map.get("dir")

    order =
      Enum.map(sort, fn s -> "#{def.columns[s["field"]]} #{dir(s["dir"])} NULLS LAST" end) ++
        ["#{def.id_sql} #{dir(first_dir)}"]

    limit = query["limit"] || 100
    offset = decode_cursor(query["cursor"])
    count_values = Enum.reverse(params)
    n = length(params)

    %{
      sql:
        "SELECT #{def.select} FROM #{def.from} #{where_sql} ORDER BY #{Enum.join(order, ", ")} " <>
          "LIMIT $#{n + 1} OFFSET $#{n + 2}",
      values: count_values ++ [limit + 1, offset],
      count_sql: "SELECT count(*)::bigint FROM #{def.from} #{where_sql}",
      count_values: count_values,
      limit: limit,
      offset: offset
    }
  end

  defp dir("desc"), do: "DESC"
  defp dir(_), do: "ASC"

  defp where(def, by_name, query) do
    filter = query["filter"]

    show_archived =
      def[:archived_field] != nil and filter != nil and mentions?(filter, def.archived_field)

    acc = {[], []}
    acc = if def[:base_where] && not show_archived, do: push(acc, def.base_where), else: acc

    acc =
      if filter do
        {sql, params} = group_sql(filter, def, by_name, elem(acc, 1))
        {[sql | elem(acc, 0)], params}
      else
        acc
      end

    {parts, params} = search(acc, def, String.trim(query["search"] || ""))
    {Enum.reverse(parts), params}
  end

  defp push({parts, params}, sql), do: {[sql | parts], params}

  defp search(acc, _def, ""), do: acc

  defp search({parts, params}, def, text) do
    {p, params} = param(params, pattern(text, def[:search_prefix] || false))
    any = Enum.map_join(def.search, " OR ", &"(#{def.columns[&1]})::text ILIKE #{p}")
    {["(#{any})" | parts], params}
  end

  @doc false
  # `%` / `_` as typed; plain text "contains", or "starts with" on prefix lists; "#123" anywhere.
  @spec pattern(String.t(), boolean()) :: String.t()
  def pattern(text, prefix) do
    cond do
      text =~ ~r/[%_]/ -> text
      prefix and not String.starts_with?(text, "#") -> text <> "%"
      true -> "%" <> text <> "%"
    end
  end

  defp mentions?(%{"conditions" => conds}, field) do
    Enum.any?(conds, fn
      %{"logic" => _} = g -> mentions?(g, field)
      c -> c["field"] == field
    end)
  end

  defp group_sql(%{"logic" => logic, "conditions" => conds}, def, by_name, params) do
    {parts, params} =
      Enum.reduce(conds, {[], params}, fn
        %{"logic" => _} = g, {parts, params} ->
          {sql, params} = group_sql(g, def, by_name, params)
          {[sql | parts], params}

        c, {parts, params} ->
          {sql, params} = condition_sql(c, by_name[c["field"]], def.columns[c["field"]], params)
          {[sql | parts], params}
      end)

    case parts do
      [] ->
        {"TRUE", params}

      _ ->
        {"(" <>
           Enum.join(Enum.reverse(parts), if(logic == "or", do: " OR ", else: " AND ")) <> ")",
         params}
    end
  end

  # Params are kept newest first; a parameter's placeholder is its position.
  defp param(params, value), do: {"$#{length(params) + 1}", [value | params]}

  defp condition_sql(c, field, x, params) do
    type = field["type"]
    numeric = type in @numeric
    time = type in @time
    typed = numeric or time or type == "boolean"

    cast =
      cond do
        type == "integer" -> "::bigint"
        numeric -> "::numeric"
        time -> "::timestamptz"
        type == "boolean" -> "::boolean"
        true -> ""
      end

    subject = if typed, do: x, else: "lower((#{x})::text)"

    one = fn params, v ->
      if typed,
        do: typed_param(params, v, type, cast),
        else: param(params, String.downcase(to_text(v)))
    end

    op_sql(c["op"], c, x, subject, cast, one, &list_param(&1, &2, type), params)
  end

  defp op_sql("eq", c, _x, subject, _cast, one, _list, params),
    do: with_param(params, one, c["value"], &"#{subject} = #{&1}")

  defp op_sql("neq", c, x, subject, _cast, one, _list, params),
    do: with_param(params, one, c["value"], &"(#{x} IS NULL OR #{subject} <> #{&1})")

  defp op_sql("like", c, x, _subject, _cast, _one, _list, params) do
    {p, params} = param(params, to_text(c["value"]))
    {"(#{x})::text ILIKE #{p}", params}
  end

  defp op_sql("not_like", c, x, _subject, _cast, _one, _list, params) do
    {p, params} = param(params, to_text(c["value"]))
    {"(#{x} IS NULL OR NOT (#{x})::text ILIKE #{p})", params}
  end

  defp op_sql("in", c, _x, subject, _cast, _one, list, params) do
    {p, params} = list.(params, c["values"])
    {"#{subject} = ANY(#{p})", params}
  end

  defp op_sql("not_in", c, x, subject, _cast, _one, list, params) do
    {p, params} = list.(params, c["values"])
    {"(#{x} IS NULL OR NOT (#{subject} = ANY(#{p})))", params}
  end

  defp op_sql("between", %{"values" => [a, b]}, x, _subject, cast, _one, _list, params) do
    {pa, params} = param(params, raw(a, cast))
    {pb, params} = param(params, raw(b, cast))
    {"#{x} BETWEEN #{pa}#{text_cast(cast)} AND #{pb}#{text_cast(cast)}", params}
  end

  defp op_sql(op, c, x, _subject, cast, _one, _list, params) when op in ~w(gt gte lt lte) do
    sign = %{"gt" => ">", "gte" => ">=", "lt" => "<", "lte" => "<="}[op]
    {p, params} = param(params, raw(c["value"], cast))
    {"#{x} #{sign} #{p}#{text_cast(cast)}", params}
  end

  defp op_sql("empty", _c, x, _subject, _cast, _one, _list, params),
    do: {"(#{x} IS NULL OR (#{x})::text = '')", params}

  defp op_sql("not_empty", _c, x, _subject, _cast, _one, _list, params),
    do: {"(#{x} IS NOT NULL AND (#{x})::text <> '')", params}

  defp op_sql("regex", c, x, _subject, _cast, _one, _list, params) do
    {p, params} = param(params, to_text(c["value"]))
    {"(#{x})::text ~* #{p}", params}
  end

  defp with_param(params, one, value, sql) do
    {p, params} = one.(params, value)
    {sql.(p), params}
  end

  defp typed_param(params, v, _type, cast) do
    {p, params} = param(params, raw(v, cast))
    {p <> text_cast(cast), params}
  end

  # The operand goes as text and is cast in SQL: PostgreSQL folds it to a constant, so indexes still apply.
  defp text_cast(""), do: ""
  defp text_cast(cast), do: "::text" <> cast

  defp raw(v, "::boolean"), do: to_text(v == true or v == "true")
  # "5.0" for an integer field reads as 5, as the mock's Number() does.
  defp raw(v, cast) when cast in ["::bigint", "::numeric"], do: to_text(Query.number(v))
  defp raw(v, _cast), do: to_text(v)

  defp list_param(params, values, type) do
    cond do
      type == "integer" ->
        array(params, Enum.map(values, &Query.number/1), "bigint")

      type in @numeric ->
        array(params, Enum.map(values, &Query.number/1), "numeric")

      type in @time ->
        array(params, values, "timestamptz")

      type == "boolean" ->
        array(params, Enum.map(values, &(&1 == true or &1 == "true")), "boolean")

      true ->
        array(params, Enum.map(values, &String.downcase(to_text(&1))), "text")
    end
  end

  defp array(params, values, sql_type) do
    {p, params} = param(params, Enum.map(values, &to_text/1))
    {"#{p}::text[]::#{sql_type}[]", params}
  end

  defp to_text(nil), do: ""
  defp to_text(v) when is_binary(v), do: v

  defp to_text(v) when is_float(v),
    do: if(v == trunc(v), do: Integer.to_string(trunc(v)), else: Float.to_string(v))

  defp to_text(v), do: to_string(v)

  @doc "The opaque cursor of a position in the sorted result (base64url JSON, as the mock writes it)."
  @spec encode_cursor(non_neg_integer()) :: String.t()
  def encode_cursor(offset), do: Base.url_encode64(~s({"o":#{offset}}), padding: false)

  @doc "The position of a cursor; 0 for none or one that cannot be read."
  @spec decode_cursor(String.t() | nil) :: non_neg_integer()
  def decode_cursor(cursor) when is_binary(cursor) and cursor != "" do
    with {:ok, json} <- Base.url_decode64(cursor, padding: false),
         {:ok, %{"o" => o}} when is_integer(o) and o >= 0 <- Jason.decode(json) do
      o
    else
      _ -> 0
    end
  end

  def decode_cursor(_cursor), do: 0
end
