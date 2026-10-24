defmodule Sms.Switch.Test.Client do
  @moduledoc """
  A minimal SMPP client for tests: connects over TCP or TLS, writes PDUs or raw bytes, and reads decoded PDUs.
  Reads are passive, so a test sees exactly what the switch sent and in which order.
  """
  alias Sms.Switch.Smpp.Pdu

  defstruct [:socket, :mod, buffer: <<>>]

  @type t :: %__MODULE__{}

  @doc "Connects to `port` on 127.0.0.1. Options: `:tls` (ssl client options), `:ip` (local address to use)."
  def connect(port, opts \\ []) do
    base = [:binary, active: false, packet: :raw] ++ if(ip = opts[:ip], do: [ip: ip], else: [])

    case Keyword.get(opts, :tls) do
      nil ->
        with {:ok, socket} <- :gen_tcp.connect(~c"127.0.0.1", port, base, 2_000),
             do: {:ok, %__MODULE__{socket: socket, mod: :gen_tcp}}

      tls ->
        with {:ok, socket} <- :ssl.connect(~c"127.0.0.1", port, base ++ tls, 5_000),
             do: {:ok, %__MODULE__{socket: socket, mod: :ssl}}
    end
  end

  @doc "Connects and binds; returns the client and the bind response."
  @spec bind(:inet.port_number(), atom(), map(), keyword()) :: {t(), Pdu.t()}
  def bind(port, command, fields, opts \\ []) do
    {:ok, client} = connect(port, opts)
    send_pdu(client, Pdu.new(command, Map.merge(%{interface_version: 0x34}, fields), sequence: 1))
    {client, resp} = recv(client)
    {client, resp}
  end

  def send_pdu(client, pdu), do: send_raw(client, Pdu.encode!(pdu))

  @spec send_raw(t(), iodata()) :: :ok
  def send_raw(%__MODULE__{mod: mod, socket: socket}, bytes), do: :ok = mod.send(socket, bytes)

  @doc "The next PDU from the switch, `{:error, :closed}` or `{:error, :timeout}`."
  @spec recv(t(), timeout()) :: {t(), Pdu.t()} | {:error, term()}
  def recv(%__MODULE__{} = client, timeout \\ 2_000) do
    case Pdu.decode(client.buffer) do
      {:ok, pdu, rest} ->
        {%{client | buffer: rest}, pdu}

      {:incomplete, _} ->
        case client.mod.recv(client.socket, 0, timeout) do
          {:ok, data} -> recv(%{client | buffer: client.buffer <> data}, timeout)
          {:error, reason} -> {:error, reason}
        end

      {:error, error, _rest} ->
        raise error
    end
  end

  @doc "Whether the switch closed the connection (within `timeout`), skipping any PDUs still on the way."
  def closed?(client, timeout \\ 2_000) do
    case recv(client, timeout) do
      {:error, :closed} -> true
      {:error, _} -> false
      {client, _pdu} -> closed?(client, timeout)
    end
  end

  @doc "Whether the peer closed the connection, whatever bytes (not necessarily SMPP) came before."
  @spec raw_closed?(t(), timeout()) :: boolean()
  def raw_closed?(%__MODULE__{mod: mod, socket: socket} = client, timeout \\ 2_000) do
    case mod.recv(socket, 0, timeout) do
      {:ok, _bytes} -> raw_closed?(client, timeout)
      {:error, :closed} -> true
      {:error, _} -> false
    end
  end

  @spec close(t()) :: :ok
  def close(%__MODULE__{mod: mod, socket: socket}), do: mod.close(socket)
end
