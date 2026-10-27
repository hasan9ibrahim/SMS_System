defmodule Sms.Core.ReleaseTest do
  # Migrations from the release (backend step 8): each PostgreSQL file once, recorded; ClickHouse every time.
  use ExUnit.Case, async: false
  alias Sms.Core.Release
  alias Sms.Core.Release.Sql

  @moduletag :integration
  @moduletag capture_log: true

  setup do
    schema = "rel_test_#{System.unique_integer([:positive])}"
    repo = [parameters: [search_path: "#{schema},public"]]
    on_exit(fn -> sql("DROP SCHEMA IF EXISTS #{schema} CASCADE") end)
    %{schema: schema, repo: repo}
  end

  defp sql(statement) do
    config = Application.fetch_env!(:sms_core, Sms.Core.Repo)
    {:ok, conn} = Sql.start_link(Keyword.put(config, :sync_connect, true))

    try do
      Sql.query!(conn, statement)
    after
      GenServer.stop(conn)
    end
  end

  defp fake_db(files) do
    dir = Path.join(System.tmp_dir!(), "rel_db_#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(dir) end)

    for {path, content} <- files do
      File.mkdir_p!(Path.dirname(Path.join(dir, path)))
      File.write!(Path.join(dir, path), content)
    end

    dir
  end

  # The migrations name their schema (`SET search_path = sms`), so the real set gets a database of its own.
  test "the repository's schema files apply to an empty database, then nothing is pending" do
    db = "sms_release_test_#{System.unique_integer([:positive])}"
    sql("CREATE DATABASE #{db}")
    on_exit(fn -> sql("DROP DATABASE IF EXISTS #{db} WITH (FORCE)") end)
    repo = [database: db, parameters: [search_path: "sms,public"]]

    result = Release.migrate(repo: repo)
    assert "postgres/init/001_extensions.sql" in result.postgres
    assert length(result.postgres) > 70
    assert "clickhouse/migrations/001_edr.sql" in result.clickhouse

    assert Release.migrate(repo: repo, clickhouse: false) == %{postgres: [], clickhouse: []}
  end

  test "a file runs once, its own BEGIN/COMMIT works, and a changed file is refused", ctx do
    dir =
      fake_db(%{
        "postgres/init/001_a.sql" => "CREATE TABLE a (x int); INSERT INTO a VALUES (1);",
        "postgres/migrations/002_b.sql" => "BEGIN;\nCREATE TABLE b (y int);\nCOMMIT;\n"
      })

    assert Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false).postgres ==
             ["postgres/init/001_a.sql", "postgres/migrations/002_b.sql"]

    File.write!(Path.join(dir, "postgres/migrations/003_c.sql"), "INSERT INTO a VALUES (2);")

    assert Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false).postgres ==
             ["postgres/migrations/003_c.sql"]

    assert sql("SELECT count(*) FROM #{ctx.schema}.a") == [["2"]]

    File.write!(Path.join(dir, "postgres/migrations/002_b.sql"), "CREATE TABLE b (z int);")

    assert_raise RuntimeError, ~r/002_b.sql changed after it was applied/, fn ->
      Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false)
    end
  end

  test "a failing file is not recorded, and the error is PostgreSQL's", ctx do
    dir = fake_db(%{"postgres/migrations/001_bad.sql" => "CREATE TABLE ok (x int); SELECT nope;"})

    assert_raise Postgrex.Error, ~r/nope/, fn ->
      Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false)
    end

    # The whole file rolled back (one implicit transaction); nothing recorded, so it runs again once fixed.
    assert sql("SELECT to_regclass('#{ctx.schema}.ok') IS NULL") == [["t"]]
    File.write!(Path.join(dir, "postgres/migrations/001_bad.sql"), "CREATE TABLE ok (x int);")

    assert Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false).postgres == [
             "postgres/migrations/001_bad.sql"
           ]
  end

  test "a schema made by the seed (tables, no record) needs a baseline first", ctx do
    dir = fake_db(%{"postgres/migrations/001_a.sql" => "CREATE TABLE a (x int);"})
    sql("CREATE SCHEMA #{ctx.schema}; CREATE TABLE #{ctx.schema}.a (x int)")

    assert_raise RuntimeError, ~r/has tables but no schema_migrations/, fn ->
      Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false)
    end

    assert Release.baseline(dir: dir, repo: ctx.repo) == ["postgres/migrations/001_a.sql"]
    assert Release.migrate(dir: dir, repo: ctx.repo, clickhouse: false).postgres == []
  end
end

defmodule Sms.Core.ReleaseUnitTest do
  use ExUnit.Case, async: true
  alias Sms.Core.Release

  test "ClickHouse statements split at a ';' ending a line, comments dropped" do
    sql =
      "-- note\nCREATE TABLE a (x String DEFAULT ';')\nENGINE = Memory;\n\nALTER TABLE a ADD COLUMN y Int8;  \n"

    assert Release.statements(sql) == [
             "CREATE TABLE a (x String DEFAULT ';')\nENGINE = Memory",
             "ALTER TABLE a ADD COLUMN y Int8"
           ]
  end

  test "on a Replicated database the MergeTree family becomes replicated" do
    assert Release.replicated("CREATE TABLE a (x Int8)\nENGINE = MergeTree\nORDER BY x") ==
             "CREATE TABLE a (x Int8)\nENGINE = ReplicatedMergeTree\nORDER BY x"

    assert Release.replicated("ENGINE=SummingMergeTree ORDER BY x") ==
             "ENGINE = ReplicatedSummingMergeTree ORDER BY x"

    assert Release.replicated("ENGINE = ReplicatedMergeTree ORDER BY x") ==
             "ENGINE = ReplicatedMergeTree ORDER BY x"

    assert Release.replicated("ENGINE = Memory") == "ENGINE = Memory"
  end

  test "EDR retention: off-site after the hot months, deleted after the kept ones, set once" do
    plain =
      "MergeTree PARTITION BY toYYYYMM(start_time) ORDER BY (start_time) SETTINGS index_granularity = 8192"

    assert [policy, drop_parts, ttl] = Release.retention_statements("edr", plain, 6, 12)
    assert policy == "ALTER TABLE edr MODIFY SETTING storage_policy = 'edr_tiered'"
    assert drop_parts == "ALTER TABLE edr MODIFY SETTING ttl_only_drop_parts = 1"

    assert ttl ==
             "ALTER TABLE edr MODIFY TTL toDateTime(start_time) + INTERVAL 6 MONTH TO VOLUME 'cold', " <>
               "toDateTime(start_time) + INTERVAL 12 MONTH DELETE"

    # As ClickHouse shows the table once set (system.tables.engine_full): nothing left to do.
    done =
      "MergeTree PARTITION BY toYYYYMM(start_time) ORDER BY (start_time) TTL toDateTime(start_time) + " <>
        "toIntervalMonth(6) TO VOLUME 'cold', toDateTime(start_time) + toIntervalMonth(12) SETTINGS " <>
        "index_granularity = 8192, ttl_only_drop_parts = 1, storage_policy = 'edr_tiered'"

    assert Release.retention_statements("edr", done, 6, 12) == []
    # Other months: the TTL again, the policy stays.
    assert [_, _] = Release.retention_statements("edr", done, 3, 12)
  end

  test "the schema files: SMS_DB_DIR, else the release's db/, else the repository's" do
    assert File.dir?(Path.join(Release.db_dir(), "postgres/migrations"))
    System.put_env("SMS_DB_DIR", "/elsewhere")
    on_exit(fn -> System.delete_env("SMS_DB_DIR") end)
    assert Release.db_dir() == "/elsewhere"
  end
end
