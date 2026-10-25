defmodule Sms.Api.Lists.Query do
  @moduledoc """
  Checks a list query (`ListQuery` in the contract, §13.25) before it becomes SQL: its shape (the contract's schema:
  known keys, `logic` and, `or`, operators, a limit of 1 to 4000, at most 5 sort keys and 200 conditions per group), then
  what the schema cannot say: every field and operator exists in the list's catalogue, operands suit the field's type
  (so the database never sees a bad cast), regular expressions compile, sorted fields are sortable (the mock's
  mock/src/lists/validate.ts). Errors are `%{path, message}` with JSON pointers into the body.
  """

  @operators ~w(eq neq like not_like in not_in between gt gte lt lte empty not_empty regex)
  @no_value ~w(empty not_empty)
  @multi ~w(in not_in between)
  @numeric ~w(integer decimal money percent)

  @type error :: %{path: String.t(), message: String.t()}

  @doc "The errors of a query against a list's catalogue; [] when it can run."
  @spec errors(term(), map()) :: [error()]
  def errors(query, catalog) when is_map(query) do
    by_name = Map.new(catalog["fields"], &{&1["field"], &1})

    unknown =
      for k <- Map.keys(query),
          k not in ~w(filter search sort limit cursor withTotal),
          do: err("/#{k}", "must NOT have additional properties")

    unknown ++
      filter_errors(query["filter"], by_name) ++
      scalar_errors(query) ++ sort_errors(query["sort"], by_name)
  end

  def errors(_query, _catalog), do: [err("/", "must be object")]

  defp scalar_errors(q) do
    [
      check(
        q["search"],
        &(is_binary(&1) and String.length(&1) <= 200),
        "/search",
        "must be a string of at most 200 characters"
      ),
      check(
        q["limit"],
        &(is_integer(&1) and &1 in 1..4000),
        "/limit",
        "must be an integer from 1 to 4000"
      ),
      check(q["cursor"], &(is_binary(&1) or is_nil(&1)), "/cursor", "must be string or null"),
      check(q["withTotal"], &is_boolean/1, "/withTotal", "must be boolean")
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp check(nil, _ok?, _path, _message), do: nil
  defp check(v, ok?, path, message), do: if(ok?.(v), do: nil, else: err(path, message))

  defp sort_errors(nil, _by_name), do: []

  defp sort_errors(sort, by_name) when is_list(sort) and length(sort) <= 5 do
    sort
    |> Enum.with_index()
    |> Enum.flat_map(fn
      {%{"field" => f, "dir" => dir} = s, i} when map_size(s) == 2 and dir in ["asc", "desc"] ->
        case by_name[f] do
          nil -> [err("/sort/#{i}/field", ~s(unknown field "#{f}"))]
          %{"sortable" => false} -> [err("/sort/#{i}/field", ~s("#{f}" is not sortable))]
          _ -> []
        end

      {_, i} ->
        [err("/sort/#{i}", "must be {field, dir: asc|desc}")]
    end)
  end

  defp sort_errors(_sort, _by_name), do: [err("/sort", "must be an array of at most 5 sort keys")]

  defp filter_errors(nil, _by_name), do: []
  defp filter_errors(group, by_name), do: group_errors(group, "/filter", by_name)

  defp group_errors(%{"logic" => logic, "conditions" => conds} = g, path, by_name)
       when logic in ["and", "or"] and is_list(conds) and map_size(g) == 2 and
              length(conds) <= 200 do
    conds
    |> Enum.with_index()
    |> Enum.flat_map(fn
      {%{"logic" => _} = sub, i} -> group_errors(sub, "#{path}/conditions/#{i}", by_name)
      {c, i} -> condition_errors(c, "#{path}/conditions/#{i}", by_name)
    end)
  end

  defp group_errors(_group, path, _by_name),
    do: [err(path, "must be {logic: and|or, conditions: [...]} with at most 200 conditions")]

  defp condition_errors(%{"field" => f, "op" => op} = c, at, by_name) when op in @operators do
    extra = Map.keys(c) -- ~w(field op value values)

    cond do
      extra != [] -> [err("#{at}/#{hd(extra)}", "must NOT have additional properties")]
      by_name[f] == nil -> [err("#{at}/field", ~s(unknown field "#{f}"))]
      true -> operator_errors(c, by_name[f], at)
    end
  end

  defp condition_errors(_c, at, _by_name),
    do: [err(at, "must be {field, op, value | values} with a known operator")]

  defp operator_errors(%{"op" => op} = c, field, at) do
    allowed =
      if op in field["operators"],
        do: [],
        else: [err("#{at}/op", ~s(operator "#{op}" is not allowed on "#{field["field"]}"))]

    values = c["values"]

    arity =
      cond do
        op in @multi and not (is_list(values) and values != []) ->
          [err("#{at}/values", ~s("#{op}" needs values))]

        op == "between" and length(values) != 2 ->
          [err("#{at}/values", ~s("between" needs exactly 2 values))]

        op not in @multi and op not in @no_value and not Map.has_key?(c, "value") ->
          [err("#{at}/value", ~s("#{op}" needs a value))]

        true ->
          []
      end

    operands =
      if is_list(values),
        do: values,
        else: if(Map.has_key?(c, "value"), do: [c["value"]], else: [])

    allowed ++
      arity ++
      Enum.flat_map(operands, &operand_errors(&1, field["type"], at)) ++ regex_errors(c, at)
  end

  defp operand_errors(v, type, at) when type in @numeric do
    case number(v) do
      nil ->
        [err("#{at}/value", ~s("#{text(v)}" is not a number))]

      n when type == "integer" and n != trunc(n) ->
        [err("#{at}/value", ~s("#{text(v)}" is not a whole number))]

      _ ->
        []
    end
  end

  defp operand_errors(v, type, at) when type in ["date", "datetime"] do
    if is_binary(v) and date?(v),
      do: [],
      else: [err("#{at}/value", ~s("#{text(v)}" is not a date \(ISO 8601\)))]
  end

  defp operand_errors(v, "boolean", at) when not is_boolean(v),
    do: [err("#{at}/value", "expected true or false")]

  defp operand_errors(v, _type, at) when is_map(v) or is_list(v),
    do: [err("#{at}/value", "must be a string, number, boolean or null")]

  defp operand_errors(_v, _type, _at), do: []

  defp regex_errors(%{"op" => "regex", "value" => v}, at) when is_binary(v) do
    case Regex.compile(v, "i") do
      {:ok, _} -> []
      {:error, _} -> [err("#{at}/value", "invalid regular expression")]
    end
  end

  defp regex_errors(_c, _at), do: []

  @doc false
  # A JSON number, or a string that reads as one (the mock accepts both).
  @spec number(term()) :: number() | nil
  def number(v) when is_number(v), do: v

  def number(v) when is_binary(v) do
    case Float.parse(String.trim(v)) do
      {n, ""} -> n
      _ -> nil
    end
  end

  def number(_v), do: nil

  defp date?(v) do
    match?({:ok, _, _}, DateTime.from_iso8601(v)) or
      match?({:ok, _}, NaiveDateTime.from_iso8601(v)) or
      match?({:ok, _}, Date.from_iso8601(v))
  end

  defp text(v) when is_binary(v), do: v
  defp text(v), do: inspect(v)

  defp err(path, message), do: %{path: path, message: message}
end
