defmodule Sms.Switch.Test.FlakyLoader do
  @moduledoc false
  # `Sms.Switch.Test.PipelineConfig` as the pipeline's loader, except for the steps told to fail (`fail/1`).
  alias Sms.Switch.Test.PipelineConfig

  @key {__MODULE__, :fail}

  def fail(steps), do: :persistent_term.put(@key, steps)
  defp failing?(step), do: step in :persistent_term.get(@key, [])

  def fingerprint, do: run(:fingerprint, &PipelineConfig.fingerprint/0)
  def rate_fingerprints, do: run(:rate_fingerprints, &PipelineConfig.rate_fingerprints/0)

  def load_snapshot(currency),
    do: run(:snapshot, fn -> PipelineConfig.load_snapshot(currency) end)

  def load_rates(tables), do: run(:load_rates, fn -> PipelineConfig.load_rates(tables) end)

  defp run(step, fun), do: if(failing?(step), do: {:error, :planned}, else: fun.())
end

defmodule Sms.Switch.Pipeline.ConfigTest do
  # The pipeline's configuration in memory and how it is kept current (S-6.6, S-7.2, §6.1, §6.2, §6.4, §7).
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog
  import Sms.Switch.Test.CustomerCase, only: [assert_eventually: 1, assert_eventually: 2]

  alias Sms.Switch.Pipeline
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Pipeline.Config.Server
  alias Sms.Switch.Test.{FlakyLoader, PipelineConfig}

  setup do
    FlakyLoader.fail([])
    on_exit(fn -> FlakyLoader.fail([]) end)
    :ok
  end

  defp now, do: System.os_time(:millisecond)

  defp start_server(opts \\ []) do
    start_supervised!({Server, Keyword.merge([loader: FlakyLoader], opts)})
    assert_eventually(&Config.ready?/0)
  end

  defp rates_with(extra) do
    [PipelineConfig.rate(100, 1, "26201", "0.05"), PipelineConfig.rate(200, 2, "26201", "0.02")] ++
      extra
  end

  describe "lookups (§6.1, §6.2, §6.4, §7)" do
    setup do
      future = DateTime.add(DateTime.utc_now(), 3_600)

      PipelineConfig.put(
        rates:
          rates_with([
            PipelineConfig.rate(100, 5, "262", "0.04"),
            # Scheduled, not current yet.
            [100, 6, "26203", Decimal.new("0.09"), "EUR", future, nil, false],
            # In a currency without an exchange rate: never usable.
            PipelineConfig.rate(100, 7, "26204", "0.01", "XXX")
          ]),
        list_entries: [
          [1, "FakeBank", nil],
          [1, "OTHER", nil],
          [2, "BANK{n}{n}", "Your code {text}"],
          [2, "BANK{n}{n}", "Code: {text}"],
          [2, "Shop", nil]
        ]
      )

      start_server()
      :ok
    end

    test "the destination of a number is its longest dial code; the platform currency is EUR" do
      assert Config.mccmnc_of("+4915112345678") == "26201"
      assert Config.mccmnc_of("4917012345678") == "262"
      assert Config.mccmnc_of("33612345678") == nil
      assert Config.platform_currency() == "EUR"
      assert is_map(Config.route_index())
    end

    test "number lists for route rules: exact, or in any case (§6.3)" do
      assert Config.list_has?(1, "FakeBank", false)
      refute Config.list_has?(1, "fakebank", false)
      assert Config.list_has?(1, "fakebank", true)
      refute Config.list_has?(1, "Nobody", true)
      refute Config.list_has?(99, "FakeBank", true)
    end

    test "number lists for translation rules: case as asked, and {n} templates stand for one digit (§6.4)" do
      assert Config.list_matches?(1, "FakeBank", true)
      refute Config.list_matches?(1, "FAKEBANK", true)
      assert Config.list_matches?(1, "FAKEBANK", false)
      assert Config.list_matches?(2, "BANK42", true)
      refute Config.list_matches?(2, "bank42", true)
      assert Config.list_matches?(2, "bank42", false)
      refute Config.list_matches?(2, "BANK4", false)
      refute Config.list_matches?(99, "BANK42", false)

      assert Config.list_entries(2) == ["BANK{n}{n}", "Shop"]
      assert Config.list_entries(99) == []
      assert Config.templates(2, "BANK{n}{n}") == ["Your code {text}", "Code: {text}"]
      assert Config.templates(2, "Shop") == []
      assert Config.templates(99, "BANK{n}{n}") == []
    end

    test "amounts convert to the platform currency at the latest exchange rate; unknown currencies do not (§7)" do
      assert Config.per_eur("USD") == 1.1
      assert Config.to_platform(Decimal.new("1.1"), "USD") == 1.0
      assert Config.to_platform(2, "EUR") == 2.0
      assert Config.to_platform(0.5, "EUR") == 0.5
      assert Config.to_platform(1, "XXX") == nil
    end

    test "rates: the network's current line, else its country's All networks line (§5.4, §6.2)" do
      t = now()

      assert %{rate_table_id: 100, mccmnc: "26201", platform: 0.05} =
               Config.sell_rate(1, "26201", t)

      # No line for the network: the All networks code.
      assert %{mccmnc: "262", platform: 0.04} = Config.sell_rate(1, "26202", t)
      # A scheduled line is not current yet, so the All networks one applies.
      assert %{mccmnc: "262"} = Config.sell_rate(1, "26203", t)
      assert %{line_id: 6, platform: 0.09} = Config.sell_rate(1, "26203", t + 7_200_000)

      # A line in a currency without an exchange rate cannot be priced; the All networks line is used.
      assert %{mccmnc: "262"} = Config.sell_rate(1, "26204", t)
      assert Config.sell_rate(99, "26201", t) == nil
      assert Config.vendor_rate(99, "26201", t) == nil
      assert %{platform: 0.02} = Config.vendor_rate(1, "26201", t)
      assert Config.vendor_rate(1, "26202", t) == nil
    end

    test "vendor options for a destination are cached a few seconds, then recomputed" do
      t = now()
      assert Config.vendor_options(nil, t) == %{}
      assert %{1 => %{cost: 0.02, tier: 1, at_limit: false}} = Config.vendor_options("26201", t)

      # A cached entry is used while it is fresh, and not when it is stale or from the future (clock change).
      :ets.insert(Config.options_table(), {"26201", t, %{cached: true}})
      assert Config.vendor_options("26201", t + 1_000) == %{cached: true}
      assert %{1 => %{cost: 0.02}} = Config.vendor_options("26201", t + 6_000)
      :ets.insert(Config.options_table(), {"26201", t, %{cached: true}})
      assert %{1 => _} = Config.vendor_options("26201", t - 1_000)
    end

    test "not ready once the server and its rate lines are gone" do
      assert Config.ready?()
      :ok = stop_supervised(Server)
      refute Config.ready?()
    end
  end

  describe "kept current (S-6.6, S-7.2)" do
    test "a loader that fails at start is tried again until the first load succeeds" do
      PipelineConfig.put()
      FlakyLoader.fail([:fingerprint])

      log =
        capture_log(fn ->
          start_supervised!({Server, loader: FlakyLoader})
          Process.sleep(200)
          refute Config.ready?()
          FlakyLoader.fail([])
          assert_eventually(&Config.ready?/0, 3_000)
        end)

      assert log =~ "pipeline configuration not loaded yet, retrying"
    end

    test "refresh reads what changed now; an unchanged fingerprint reads nothing; a failure keeps the old" do
      PipelineConfig.put()
      start_server()
      assert Server.refresh() == :ok
      assert Config.customer_trunk(1).name == "FAKE_CUSTOMER"

      PipelineConfig.put(customer_trunks: [PipelineConfig.customer_trunk(name: "RENAMED")])
      assert Server.refresh() == :ok
      assert Config.customer_trunk(1).name == "RENAMED"

      FlakyLoader.fail([:snapshot])
      PipelineConfig.put(customer_trunks: [PipelineConfig.customer_trunk(name: "NOT_SEEN")])
      assert Server.refresh() == {:error, :planned}
      assert Config.customer_trunk(1).name == "RENAMED"

      FlakyLoader.fail([:rate_fingerprints])
      assert Server.refresh() == {:error, :planned}
      FlakyLoader.fail([])
      assert Server.refresh() == :ok
      assert Config.customer_trunk(1).name == "NOT_SEEN"
    end

    test "rate tables that failed to load are read again; a table or code that is gone is removed" do
      PipelineConfig.put(rates: rates_with([PipelineConfig.rate(100, 5, "262", "0.04")]))
      start_server()
      t = now()
      assert %{platform: 0.02} = Config.vendor_rate(1, "26201", t)
      assert %{mccmnc: "262"} = Config.sell_rate(1, "26202", t)

      # Loading the lines fails: the old ones stay in use.
      FlakyLoader.fail([:load_rates])
      PipelineConfig.put(rates: [PipelineConfig.rate(100, 1, "26201", "0.06")])
      assert Server.refresh() == {:error, :planned}
      assert %{platform: 0.05} = Config.sell_rate(1, "26201", t)

      # Then it works: table 200 is gone, and so is code 262 of table 100.
      FlakyLoader.fail([])
      assert Server.refresh() == :ok
      assert %{platform: 0.06} = Config.sell_rate(1, "26201", t)
      assert Config.vendor_rate(1, "26201", t) == nil
      assert Config.sell_rate(1, "26202", t) == nil
    end

    test "the timers pick up changes by themselves and keep the old configuration when a read fails" do
      PipelineConfig.put()
      start_server(refresh_ms: 50, rates_refresh_ms: 50)

      PipelineConfig.put(
        customer_trunks: [PipelineConfig.customer_trunk(name: "TICKED")],
        rates: [PipelineConfig.rate(100, 1, "26201", "0.07")]
      )

      assert_eventually(fn -> Config.customer_trunk(1).name == "TICKED" end)
      assert_eventually(fn -> match?(%{platform: 0.07}, Config.sell_rate(1, "26201", now())) end)

      log =
        capture_log(fn ->
          FlakyLoader.fail([:fingerprint, :rate_fingerprints])
          PipelineConfig.put(customer_trunks: [PipelineConfig.customer_trunk(name: "LATER")])
          Process.sleep(300)
          assert Config.ready?()
          assert Config.customer_trunk(1).name == "TICKED"
          :ok = stop_supervised(Server)
        end)

      assert log =~ "pipeline configuration not refreshed, keeping the previous one"
      assert log =~ "rate lines not refreshed, keeping the previous ones"
    end
  end

  describe "the pipeline supervisor" do
    setup do
      previous = Application.get_env(:sms_switch, Pipeline, [])
      Application.put_env(:sms_switch, Pipeline, Keyword.put(previous, :loader, FlakyLoader))
      on_exit(fn -> Application.put_env(:sms_switch, Pipeline, previous) end)
      :ok
    end

    test "starts the store, the configuration and the consumers, configured from the application" do
      PipelineConfig.put()
      start_supervised!(Sms.Core.Bus)
      start_supervised!(Pipeline.Supervisor)
      assert_eventually(&Config.ready?/0)

      for child <- [Pipeline.Store, Server, Pipeline.Held] do
        assert is_pid(Process.whereis(child)), "#{inspect(child)} is not running"
      end

      ids =
        for {id, _pid, _type, _modules} <- Supervisor.which_children(Pipeline.Supervisor), do: id

      for consumer <- [
            Pipeline.EdrWriter,
            Pipeline.Sender,
            Pipeline.Forwarder,
            Pipeline.Held.OnBind
          ],
          do: assert(consumer in ids)

      assert Config.customer_trunk(1).name == "FAKE_CUSTOMER"
    end
  end
end
