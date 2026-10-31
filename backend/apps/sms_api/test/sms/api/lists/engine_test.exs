defmodule Sms.Api.Lists.EngineTest do
  # The list engine (§13.25): SQL per operator and field type, search patterns, sort and paging; then the ported
  # lists through the API against PostgreSQL.
  use ExUnit.Case, async: false
  alias Sms.Api.Lists.{Catalog, Defs, Engine}

  defp compile(query), do: Engine.compile(Defs.audit_log(), Catalog.fields("audit_log"), query)
  defp where(c), do: compile(%{"filter" => %{"logic" => "and", "conditions" => c}})

  test "operators by field type" do
    q = where([%{"field" => "id", "op" => "eq", "value" => "5.0"}])
    assert q.sql =~ "(a.id = $1::text::bigint)"
    assert hd(q.values) == "5"

    assert where([%{"field" => "action", "op" => "eq", "value" => "UpDate"}]).values |> hd() ==
             "update"

    assert where([%{"field" => "action", "op" => "neq", "value" => "x"}]).sql =~
             "a.action IS NULL OR lower"

    assert where([%{"field" => "method", "op" => "in", "values" => ["PUT"]}]).sql =~
             "= ANY($1::text[]::text[])"

    assert where([%{"field" => "id", "op" => "not_in", "values" => [1, 2]}]).sql =~
             "::text[]::bigint[]"

    assert where([%{"field" => "at", "op" => "in", "values" => ["2026-10-01T00:00:00Z"]}]).sql =~
             "timestamptz[]"

    assert where([%{"field" => "id", "op" => "between", "values" => [1, 9]}]).sql =~
             "BETWEEN $1::text::bigint AND $2"

    assert where([%{"field" => "at", "op" => "lt", "value" => "2026-10-01"}]).sql =~
             "a.at < $1::text::timestamptz"

    assert where([%{"field" => "action", "op" => "not_like", "value" => "%x"}]).sql =~
             "NOT (a.action)::text ILIKE"

    assert where([%{"field" => "masterId", "op" => "not_empty"}]).sql =~ "IS NOT NULL AND"
    assert where([%{"field" => "action", "op" => "regex", "value" => "^a"}]).sql =~ "~* $1"
    assert where([]).sql =~ "WHERE TRUE"
  end

  test "groups, search patterns, sort and paging" do
    q =
      compile(%{
        "filter" => %{
          "logic" => "or",
          "conditions" => [
            %{"field" => "status", "op" => "gte", "value" => 400},
            %{
              "logic" => "and",
              "conditions" => [%{"field" => "method", "op" => "eq", "value" => "PUT"}]
            }
          ]
        },
        "search" => "  Rule ",
        "sort" => [%{"field" => "user", "dir" => "desc"}],
        "limit" => 10,
        "cursor" => Engine.encode_cursor(30)
      })

    assert q.sql =~ " OR ("
    # Text sorts case-insensitively (QA 2026-10-31).
    assert q.sql =~
             "ORDER BY lower((u.username)::text) DESC NULLS LAST, a.id DESC LIMIT $4 OFFSET $5"

    assert Enum.take(q.values, -3) == ["%Rule%", 11, 30]
    assert q.count_values == Enum.drop(q.values, -2)

    assert Engine.pattern("Colo", true) == "Colo%"
    assert Engine.pattern("#12", true) == "%#12%"
    # Wildcard text is the start of a value unless it ends in % (QA 2026-10-31).
    assert Engine.pattern("a_b", false) == "a_b%"
    assert Engine.pattern("ALDEX_C", true) == "ALDEX_C%"
    assert Engine.pattern("%x", false) == "%x%"
    assert Engine.pattern("50\\%", false) == "50\\%%"
    assert Engine.pattern("ab\\", false) == "%ab\\\\%"
    assert Engine.decode_cursor("not-base64!") == 0
    assert Engine.decode_cursor(Base.url_encode64(~s({"o":-1}), padding: false)) == 0
    assert Engine.decode_cursor(nil) == 0
  end

  test "a time in a filter is its whole millisecond (QA 2026-10-31)" do
    t = "2026-10-31T10:00:00.123Z"
    q = where([%{"field" => "at", "op" => "between", "values" => [t, t]}])

    assert q.sql =~
             "(a.at >= $1::text::timestamptz AND a.at < ($2::text::timestamptz + interval '1 millisecond'))"

    assert where([%{"field" => "at", "op" => "lte", "value" => t}]).sql =~ "a.at < ($1"
    assert where([%{"field" => "at", "op" => "gt", "value" => t}]).sql =~ "a.at >= ($1"

    assert where([%{"field" => "at", "op" => "gte", "value" => t}]).sql =~
             "a.at >= $1::text::timestamptz"
  end

  test "a list's base condition is lifted when its archived field is filtered" do
    def = Map.merge(Defs.audit_log(), %{base_where: "a.status < 500", archived_field: "status"})
    catalog = Catalog.fields("audit_log")
    assert Engine.compile(def, catalog, %{}).sql =~ "WHERE a.status < 500"

    filtered = %{
      "filter" => %{
        "logic" => "and",
        "conditions" => [%{"field" => "status", "op" => "gte", "value" => 1}]
      }
    }

    refute Engine.compile(def, catalog, filtered).sql =~ "a.status < 500"
  end

  test "booleans compare as booleans" do
    def = Map.put(Defs.audit_log(), :columns, Map.put(Defs.audit_log().columns, "on", "true"))

    catalog = %{
      "defaultSort" => [],
      "fields" => [
        %{"field" => "on", "type" => "boolean", "operators" => ["eq", "in"], "sortable" => true}
      ]
    }

    q =
      Engine.compile(def, catalog, %{
        "filter" => %{
          "logic" => "and",
          "conditions" => [%{"field" => "on", "op" => "eq", "value" => true}]
        }
      })

    assert q.sql =~ "true = $1::text::boolean"
    assert hd(q.values) == "true"

    q =
      Engine.compile(def, catalog, %{
        "filter" => %{
          "logic" => "and",
          "conditions" => [%{"field" => "on", "op" => "in", "values" => [true, "false"]}]
        }
      })

    assert hd(q.values) == ["true", "false"]
  end
end
