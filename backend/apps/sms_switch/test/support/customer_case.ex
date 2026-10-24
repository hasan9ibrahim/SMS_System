defmodule Sms.Switch.Test.CustomerCase do
  @moduledoc """
  Starts the customer side for a test: a plain listener (and a TLS one with a throw-away certificate) on free ports,
  trunks served from memory (`put_trunks/1`), the test intake and short timeouts.
  """
  use ExUnit.CaseTemplate
  alias Sms.Switch.Customer.{Listener, Trunk}
  alias Sms.Switch.Test.Intake

  using do
    quote do
      import Sms.Switch.Test.CustomerCase
      alias Sms.Switch.Customer
      alias Sms.Switch.Customer.{Trunk, TrunkStore}
      alias Sms.Switch.Smpp.Pdu
      alias Sms.Switch.Test.Client
    end
  end

  @trunks {__MODULE__, :trunks}

  @doc "A trunk for tests: TRX-capable, 127.0.0.1 allowed, password `secret`."
  def trunk(fields \\ []) do
    struct!(
      %Trunk{
        id: 1,
        username: "acme",
        password: "secret",
        name: "ACME_OTP",
        host_ips: [{{127, 0, 0, 1}, 32}],
        max_connections: 2,
        tps: 1_000,
        bind_type: :auto,
        status: :active
      },
      fields
    )
  end

  @doc "The trunks the store loads next (call `Customer.reload_trunks/0` to load them now)."
  def put_trunks(trunks_or_error), do: :persistent_term.put(@trunks, trunks_or_error)

  def load_trunks do
    case :persistent_term.get(@trunks, {:ok, []}) do
      {:error, _} = error -> error
      trunks -> {:ok, trunks}
    end
  end

  @doc "The setup: options override the supervisor's (e.g. `session: [...]`, `bind_guard: [...]`)."
  def start_customer(context_opts \\ []) do
    Intake.own()
    put_trunks(Keyword.get(context_opts, :trunks, [trunk()]))
    {certfile, keyfile} = certificate()

    opts =
      Keyword.merge(
        [
          listeners: [[port: 0, name: :plain], [port: 0, name: :tls, tls: true]],
          tls: [certfile: certfile, keyfile: keyfile],
          intake: Intake,
          trunk_loader: &load_trunks/0,
          trunk_refresh_ms: 60_000,
          session: [bind_timeout_ms: 2_000, enquire_link_interval_ms: 60_000, tick_ms: 50],
          bind_guard: [max_failures: 3]
        ],
        Keyword.delete(context_opts, :trunks),
        fn
          :session, a, b -> Keyword.merge(a, b)
          _key, _a, b -> b
        end
      )

    start_supervised!({Sms.Switch.Customer.Supervisor, opts})

    for listener <- opts[:listeners], into: %{} do
      name = Keyword.fetch!(listener, :name)
      key = if name == :plain, do: :port, else: :"#{name}_port"
      {key, Listener.port(Listener.ref(name))}
    end
  end

  @doc "Waits up to `timeout` ms for `fun` to return true."
  def assert_eventually(fun, timeout \\ 2_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    wait_until(fun, deadline)
  end

  defp wait_until(fun, deadline) do
    cond do
      fun.() ->
        true

      System.monotonic_time(:millisecond) > deadline ->
        ExUnit.Assertions.flunk("condition not met in time")

      true ->
        Process.sleep(10)
        wait_until(fun, deadline)
    end
  end

  @doc "A self-signed server certificate and key in files (generated once per test run)."
  def certificate do
    case :persistent_term.get({__MODULE__, :cert}, nil) do
      nil ->
        dir =
          Path.join(System.tmp_dir!(), "sms-switch-test-#{System.unique_integer([:positive])}")

        File.mkdir_p!(dir)

        %{cert: cert, key: key} =
          :public_key.pkix_test_root_cert(~c"SMS test",
            digest: :sha256,
            key: {:rsa, 2048, 65_537}
          )

        certfile = Path.join(dir, "cert.pem")
        keyfile = Path.join(dir, "key.pem")
        File.write!(certfile, :public_key.pem_encode([{:Certificate, cert, :not_encrypted}]))

        File.write!(
          keyfile,
          :public_key.pem_encode([:public_key.pem_entry_encode(elem(key, 0), key)])
        )

        :persistent_term.put({__MODULE__, :cert}, {certfile, keyfile})
        {certfile, keyfile}

      files ->
        files
    end
  end
end
