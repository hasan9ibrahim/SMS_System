defmodule Sms.Core.Release do
  @moduledoc """
  Database migrations from the release (backend step 8), run by the deploy before the first server gets the new
  version: `bin/sms eval "Sms.Core.Release.migrate()"`. The schema files are the ones the mock server and CI use
  (`db/postgres/init`, `db/postgres/migrations`, `db/clickhouse/migrations`), copied into the release at `db/`.

    * **PostgreSQL:** each file not yet recorded in `schema_migrations` (in the application schema) runs once, in
      name order, as one simple-protocol query (as the mock runs them, so a file's own BEGIN/COMMIT works), and is
      recorded with its SHA-256. A file whose content changed after it was applied is refused: a new file is needed.
      An advisory lock keeps two runs apart. A database that already has the schema but no record (made by the
      mock's seed) is refused unless `baseline()` first records every file as applied.
    * **ClickHouse:** every file runs each time (they are idempotent, `IF NOT EXISTS`), statement by statement. On the
      servers the EDR database is `Replicated` (both servers hold every EDR; deploy/ansible/roles/clickhouse): there
      a `...MergeTree` engine is created as `Replicated...MergeTree`, which the database places in Keeper itself.
      Development and CI keep the plain engines of the same files.

  Migrations must work with the version still running on the other server (spec §14.1): add, never rename or drop in
  the same release.
  """
  require Logger
  alias Sms.Core.Release.Sql

  @lock 4_242_018

  @doc "Applies the pending PostgreSQL migrations and the ClickHouse schema; returns the files applied."
  @spec migrate(keyword()) :: %{postgres: [String.t()], clickhouse: [String.t()]}
  def migrate(opts \\ []) do
    dir = Keyword.get_lazy(opts, :dir, &db_dir/0)
    pg = postgres(dir, :migrate, opts)
    ch = if Keyword.get(opts, :clickhouse, true), do: clickhouse(dir), else: []
    %{postgres: pg, clickhouse: ch}
  end

  @doc "Records every PostgreSQL file as applied without running it (a database made by the mock's seed)."
  @spec baseline(keyword()) :: [String.t()]
  def baseline(opts \\ []), do: postgres(Keyword.get_lazy(opts, :dir, &db_dir/0), :baseline, opts)

  @doc false
  # db/ in the release, else the repository's.
  def db_dir do
    release = Path.join(to_string(:code.root_dir()), "db")

    cond do
      dir = System.get_env("SMS_DB_DIR") -> dir
      File.dir?(release) -> release
      true -> Path.expand("../../../../../../db", __DIR__)
    end
  end

  # ---------------------------------------------------------------- PostgreSQL

  defp postgres(dir, mode, opts) do
    {:ok, _} = Application.ensure_all_started(:postgrex)

    config =
      Keyword.merge(
        Application.fetch_env!(:sms_core, Sms.Core.Repo),
        Keyword.get(opts, :repo, [])
      )

    schema = schema(config)
    {:ok, conn} = Sql.start_link(Keyword.put(config, :sync_connect, true))

    try do
      _ = Sql.query!(conn, "SELECT pg_advisory_lock(#{@lock})")
      files = files(dir, ["postgres/init", "postgres/migrations"])
      applied = applied(conn, schema, mode)
      check_changed!(files, applied)

      for {name, path, sha} <- files, not Map.has_key?(applied, name) do
        if mode == :migrate do
          Logger.info("migration #{name}")
          _ = Sql.query!(conn, File.read!(path))
        end

        _ =
          Sql.query!(
            conn,
            "INSERT INTO #{schema}.schema_migrations (file, sha256) VALUES (#{quote_literal(name)}, '#{sha}')"
          )

        name
      end
    after
      GenServer.stop(conn)
    end
  end

  # The record, created when missing; a schema already holding tables without it is not ours to guess about.
  defp applied(conn, schema, mode) do
    exists? =
      Sql.query!(conn, "SELECT to_regclass('#{schema}.schema_migrations') IS NOT NULL") == [["t"]]

    if not exists? do
      tables =
        Sql.query!(
          conn,
          "SELECT count(*) FROM pg_tables WHERE schemaname = #{quote_literal(schema)}"
        )

      if tables != [["0"]] and mode == :migrate do
        raise "schema #{schema} has tables but no schema_migrations: run Sms.Core.Release.baseline() if they " <>
                "match the migrations"
      end

      Sql.query!(conn, """
      CREATE SCHEMA IF NOT EXISTS #{schema};
      CREATE TABLE #{schema}.schema_migrations (
        file text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
      """)
    end

    conn
    |> Sql.query!("SELECT file, sha256 FROM #{schema}.schema_migrations")
    |> Map.new(fn [f, s] -> {f, s} end)
  end

  defp check_changed!(files, applied) do
    case Enum.find(files, fn {name, _path, sha} ->
           Map.has_key?(applied, name) and applied[name] != sha
         end) do
      nil ->
        :ok

      {name, _, _} ->
        raise "migration #{name} changed after it was applied: add a new migration instead"
    end
  end

  defp schema(config) do
    config
    |> Keyword.get(:parameters, [])
    |> Keyword.get(:search_path, "sms")
    |> String.split(",")
    |> hd()
  end

  # ---------------------------------------------------------------- ClickHouse

  defp clickhouse(dir) do
    {:ok, _} = Application.ensure_all_started(:ch)
    config = Application.fetch_env!(:sms_core, Sms.Core.ClickHouse)
    {:ok, conn} = Ch.start_link(Keyword.drop(config, [:pool_size]))

    try do
      replicated? =
        Ch.query!(conn, "SELECT engine FROM system.databases WHERE name = currentDatabase()").rows ==
          [["Replicated"]]

      for {name, path, _sha} <- files(dir, ["clickhouse/migrations"]) do
        Enum.each(statements(File.read!(path)), fn statement ->
          Ch.query!(conn, if(replicated?, do: replicated(statement), else: statement))
        end)

        name
      end
    after
      GenServer.stop(conn)
    end
  end

  @doc false
  # Statements end with ';' at the end of a line; comment lines dropped (tools/apply_clickhouse.py).
  def statements(sql) do
    sql
    |> String.replace(~r/^\s*--.*$/m, "")
    |> String.split(~r/;\s*$/m)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  @doc false
  # A table engine of the MergeTree family as its replicated twin, with no Keeper path (a Replicated database sets it).
  def replicated(statement),
    do:
      Regex.replace(
        ~r/ENGINE\s*=\s*(?!Replicated)(\w*MergeTree)\b/,
        statement,
        "ENGINE = Replicated\\1"
      )

  # ---------------------------------------------------------------- files

  defp files(dir, subdirs) do
    for sub <- subdirs,
        path <- dir |> Path.join(sub) |> Path.join("*.sql") |> Path.wildcard() |> Enum.sort() do
      content = File.read!(path)

      {Path.join(sub, Path.basename(path)), path,
       Base.encode16(:crypto.hash(:sha256, content), case: :lower)}
    end
  end

  defp quote_literal(text), do: "'" <> String.replace(text, "'", "''") <> "'"
end
