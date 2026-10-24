defmodule Sms.Switch.Test.VendorCase do
  @moduledoc """
  Starts the vendor side for a test against a fake vendor SMSC (`Sms.Switch.Test.FakeSmsc`): trunks served from memory
  (`put_trunks/1`, then `Sms.Switch.Vendor.reload_trunks/0`), the test receipt handler and short timers.
  """
  use ExUnit.CaseTemplate
  alias Sms.Core.Bus.Local
  alias Sms.Switch.Test.{CustomerCase, FakeSmsc, Receipts}
  alias Sms.Switch.Vendor
  alias Sms.Switch.Vendor.Trunk

  using do
    quote do
      import Sms.Switch.Test.VendorCase

      import Sms.Switch.Test.CustomerCase,
        only: [assert_eventually: 1, assert_eventually: 2, certificate: 0]

      alias Sms.Core.Bus.Local
      alias Sms.Switch.Smpp.Pdu
      alias Sms.Switch.Test.FakeSmsc
      alias Sms.Switch.Vendor
      alias Sms.Switch.Vendor.{Manager, Session, Trunk}
    end
  end

  @trunks {__MODULE__, :trunks}

  @doc "A vendor trunk for tests, pointing at `port` on 127.0.0.1: TR bind, one connection, retry after 1 s."
  def trunk(port, fields \\ []) do
    struct!(
      %Trunk{
        id: 1,
        name: "VENDOR_A",
        host: "127.0.0.1",
        port: port,
        username: "switch",
        password: "secret",
        bind_type: :trx,
        max_connections: 1,
        tps: 1_000,
        window_size: 10,
        reconnect_schedule_s: [1],
        status: :active
      },
      fields
    )
  end

  @doc "The trunks the store loads next."
  def put_trunks(trunks), do: :persistent_term.put(@trunks, trunks)

  def load_trunks, do: {:ok, :persistent_term.get(@trunks, [])}

  @doc "Replaces the trunks and loads them now."
  def reload(trunks) do
    put_trunks(trunks)
    {:ok, _} = Vendor.reload_trunks()
    :ok
  end

  @doc "Starts the vendor side with `trunks`; options override the supervisor's (e.g. `session: [...]`)."
  def start_vendor(trunks, opts \\ []) do
    Receipts.own()
    put_trunks(trunks)
    _ = unless Process.whereis(Sms.Switch.Throttle), do: start_supervised!(Sms.Switch.Throttle)

    opts =
      Keyword.merge(
        [
          receipts: Receipts,
          trunk_loader: &load_trunks/0,
          trunk_refresh_ms: 60_000,
          session: [
            tick_ms: 50,
            bind_timeout_ms: 1_000,
            connect_timeout_ms: 1_000,
            unbind_timeout_ms: 500
          ]
        ],
        opts,
        fn
          :session, a, b -> Keyword.merge(a, b)
          _key, _a, b -> b
        end
      )

    start_supervised!({Sms.Switch.Vendor.Supervisor, opts})
  end

  @doc "Starts a fake SMSC owned by the test, stopped when the test ends."
  def start_smsc(opts \\ []) do
    smsc = FakeSmsc.start(opts)
    on_exit(fn -> if Process.alive?(smsc), do: FakeSmsc.stop(smsc) end)
    smsc
  end

  @doc "Waits for the next bind on the fake SMSC; returns `{connection, pdu}`."
  defmacro assert_bind(timeout \\ 2_000) do
    quote do
      assert_receive {:smsc, conn, %Sms.Switch.Smpp.Pdu{command: c} = pdu}
                     when c in [:bind_transmitter, :bind_receiver, :bind_transceiver],
                     unquote(timeout)

      {conn, pdu}
    end
  end

  @doc "Waits until trunk `id` has `n` bound connections able to send, on any node."
  def await_bound(id, n, timeout \\ 3_000) do
    CustomerCase.assert_eventually(
      fn -> length(:pg.get_members(:sms_vendor_sessions, {:tx, id})) == n end,
      timeout
    )
  end

  @doc "The vendor events published so far with this subject suffix (`\"bound\"`…)."
  def events(what) do
    for e <- Local.published(), e.subject == "sms.session.vendor.#{what}", do: e.data
  end
end
