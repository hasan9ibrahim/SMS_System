defmodule Sms.Api.Lists.QueryTest do
  # List queries checked against a list's catalogue before they become SQL (§13.25).
  use ExUnit.Case, async: true
  alias Sms.Api.Lists.{Catalog, Query}

  @audit Catalog.fields("audit_log")

  defp paths(query), do: query |> Query.errors(@audit) |> Enum.map(& &1.path)
  defp cond1(c), do: %{"filter" => %{"logic" => "and", "conditions" => [c]}}

  test "a query that fits has no errors" do
    assert Query.errors(%{}, @audit) == []

    q = %{
      "filter" => %{
        "logic" => "and",
        "conditions" => [
          %{"field" => "id", "op" => "between", "values" => [1, "20"]},
          %{"logic" => "or", "conditions" => [%{"field" => "masterId", "op" => "empty"}]}
        ]
      },
      "sort" => [%{"field" => "at", "dir" => "desc"}],
      "search" => "x",
      "limit" => 4000,
      "cursor" => nil,
      "withTotal" => false
    }

    assert Query.errors(q, @audit) == []
  end

  test "shape errors" do
    assert Query.errors("nope", @audit) == [%{path: "/", message: "must be object"}]
    assert paths(%{"extra" => 1}) == ["/extra"]
    assert paths(%{"limit" => 0}) == ["/limit"]

    assert paths(%{"limit" => 4001, "withTotal" => "yes", "cursor" => 5, "search" => 7})
           |> Enum.sort() ==
             ["/cursor", "/limit", "/search", "/withTotal"]

    assert paths(%{"sort" => [%{"field" => "at"}]}) == ["/sort/0"]
    assert paths(%{"sort" => List.duplicate(%{"field" => "at", "dir" => "asc"}, 6)}) == ["/sort"]
    assert paths(%{"filter" => %{"logic" => "xor", "conditions" => []}}) == ["/filter"]

    assert paths(cond1(%{"field" => "id", "op" => "eq", "value" => 1, "other" => 2})) == [
             "/filter/conditions/0/other"
           ]

    assert paths(cond1(%{"field" => "id", "op" => "approx", "value" => 1})) == [
             "/filter/conditions/0"
           ]
  end

  test "catalogue errors: fields, operators, operands, regexes, sorting" do
    assert paths(cond1(%{"field" => "nope", "op" => "eq", "value" => 1})) == [
             "/filter/conditions/0/field"
           ]

    assert paths(cond1(%{"field" => "id", "op" => "regex", "value" => "1"})) == [
             "/filter/conditions/0/op"
           ]

    assert paths(cond1(%{"field" => "id", "op" => "eq", "value" => "abc"})) == [
             "/filter/conditions/0/value"
           ]

    assert paths(cond1(%{"field" => "id", "op" => "eq", "value" => 1.5})) == [
             "/filter/conditions/0/value"
           ]

    assert paths(cond1(%{"field" => "id", "op" => "eq"})) == ["/filter/conditions/0/value"]

    assert paths(cond1(%{"field" => "id", "op" => "in", "values" => []})) == [
             "/filter/conditions/0/values"
           ]

    assert paths(cond1(%{"field" => "id", "op" => "between", "values" => [1]})) == [
             "/filter/conditions/0/values"
           ]

    assert paths(cond1(%{"field" => "at", "op" => "gte", "value" => "yesterday"})) == [
             "/filter/conditions/0/value"
           ]

    assert paths(cond1(%{"field" => "at", "op" => "gte", "value" => "2026-10-01"})) == []

    assert paths(cond1(%{"field" => "action", "op" => "regex", "value" => "("})) == [
             "/filter/conditions/0/value"
           ]

    assert paths(cond1(%{"field" => "action", "op" => "eq", "value" => %{"a" => 1}})) == [
             "/filter/conditions/0/value"
           ]

    assert paths(%{"sort" => [%{"field" => "nope", "dir" => "asc"}]}) == ["/sort/0/field"]
  end

  test "booleans and unsortable fields" do
    catalog = %{
      "fields" => [
        %{"field" => "on", "type" => "boolean", "operators" => ["eq"], "sortable" => false}
      ]
    }

    assert Query.errors(cond1(%{"field" => "on", "op" => "eq", "value" => "true"}), catalog)
           |> length() == 1

    assert Query.errors(cond1(%{"field" => "on", "op" => "eq", "value" => true}), catalog) == []

    assert [%{path: "/sort/0/field"}] =
             Query.errors(%{"sort" => [%{"field" => "on", "dir" => "asc"}]}, catalog)
  end
end
