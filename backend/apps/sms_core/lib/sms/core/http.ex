defmodule Sms.Core.Http do
  @moduledoc """
  The health and metrics endpoint of a node, for monitoring (backend step 8): Prometheus scrapes `GET /metrics`
  every 15 s, and the deploy waits on `GET /health` before moving to the next server. `SWITCH_HTTP_PORT` (0 = off);
  the firewall opens it to the monitoring host only.

    * `/health`: 200 `ok` when every data store and the bus answer (`Sms.Core.Health`), else 503 with the ones that
      did not;
    * `/metrics`: the Prometheus text format, from `Sms.Core.Metrics` and the providers configured under
      `config :sms_core, Sms.Core.Http, providers: [...]` (the switch adds its own).

  A deliberately small HTTP/1.1 server (one request per connection, `Connection: close`): it serves two GETs to one
  scraper, so no web server dependency is worth it.
  """
  use GenServer
  require Logger
  alias Sms.Core.{Health, Metrics}

  @read_timeout 5_000

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc "The port it listens on (0 asks the system for one; tests)."
  @spec port() :: :inet.port_number()
  def port, do: GenServer.call(__MODULE__, :port)

  @impl true
  def init(opts) do
    {:ok, socket} =
      :gen_tcp.listen(Keyword.fetch!(opts, :port), [
        :binary,
        packet: :http_bin,
        active: false,
        reuseaddr: true
      ])

    {:ok, port} = :inet.port(socket)
    Logger.info("health and metrics on port #{port}")
    pid = self()
    spawn_link(fn -> accept(socket, pid, Keyword.get(opts, :providers, [])) end)
    {:ok, %{socket: socket, port: port}}
  end

  @impl true
  def handle_call(:port, _from, state), do: {:reply, state.port, state}

  defp accept(socket, owner, providers) do
    case :gen_tcp.accept(socket) do
      {:ok, conn} ->
        {:ok, pid} = Task.start(fn -> serve(conn, providers) end)
        :ok = :gen_tcp.controlling_process(conn, pid)
        send(pid, :go)
        accept(socket, owner, providers)

      {:error, reason} ->
        exit(reason)
    end
  end

  defp serve(conn, providers) do
    receive do
      :go -> :ok
    end

    {status, type, body} =
      case read_request(conn) do
        {:ok, :GET, "/health"} -> health()
        {:ok, :GET, "/metrics"} -> {200, "text/plain; version=0.0.4", Metrics.render(providers)}
        {:ok, _method, _path} -> {404, "text/plain", "not found\n"}
        {:error, _} -> {400, "text/plain", "bad request\n"}
      end

    head =
      "HTTP/1.1 #{status} #{reason(status)}\r\ncontent-type: #{type}\r\n" <>
        "content-length: #{IO.iodata_length(body)}\r\nconnection: close\r\n\r\n"

    _ = :gen_tcp.send(conn, [head, body])
    :gen_tcp.close(conn)
  end

  # The request line, then the headers up to the blank line (ignored).
  defp read_request(conn) do
    with {:ok, {:http_request, method, {:abs_path, path}, _}} <-
           :gen_tcp.recv(conn, 0, @read_timeout),
         :ok <- skip_headers(conn) do
      {:ok, method, path |> String.split("?") |> hd()}
    else
      {:ok, other} -> {:error, other}
      {:error, _} = error -> error
    end
  end

  defp skip_headers(conn) do
    case :gen_tcp.recv(conn, 0, @read_timeout) do
      {:ok, {:http_header, _, _, _, _}} -> skip_headers(conn)
      {:ok, :http_eoh} -> :ok
      {:ok, other} -> {:error, other}
      {:error, _} = error -> error
    end
  end

  defp health do
    case Health.check() do
      %{overall: :ok} ->
        {200, "text/plain", "ok\n"}

      %{services: services} ->
        down = for {name, status} <- services, status != :ok, do: "#{name}: #{inspect(status)}\n"
        {503, "text/plain", ["degraded\n" | down]}
    end
  end

  defp reason(200), do: "OK"
  defp reason(400), do: "Bad Request"
  defp reason(404), do: "Not Found"
  defp reason(503), do: "Service Unavailable"
end
