defmodule Sms.Switch.Customer.Listener do
  @moduledoc """
  The TCP and TLS ports clients bind to (spec §2, §5.4 Port and SSLType), one ranch listener per configured port:

      config :sms_switch, Sms.Switch.Customer,
        listeners: [[port: 2775], [port: 2776, tls: true]],
        tls: [certfile: "/etc/sms/tls/smpp.pem", keyfile: "/etc/sms/tls/smpp.key"]

  Every server listens on the same two ports for every customer: 2775 plain and 2776 TLS (product owner,
  2026-10-24). A trunk whose SSLType is TLS binds only over TLS at that version or newer
  (`Sms.Switch.Customer.Trunk.transport_allowed?/2`); a plain trunk may use either port. TLS ports offer 1.3, 1.2 and, for legacy partners, 1.1 and
  1.0 (decision Q9; SSLv2/SSLv3 never), each with the runtime's default cipher suites for that version.

  `proxy_protocol: true` reads a PROXY header (v1 or v2) before anything else, for listeners behind a load balancer
  (S-1.15, §13.1 rule 7). Sockets use TCP keepalive (S-1.6) and a send timeout, so a client that stops reading
  cannot hold a session forever.
  """
  alias Sms.Switch.Customer.Session

  @tls_versions [:"tlsv1.3", :"tlsv1.2", :"tlsv1.1", :tlsv1]
  @socket_defaults [
    keepalive: true,
    nodelay: true,
    send_timeout: 15_000,
    send_timeout_close: true,
    backlog: 1024
  ]

  @doc """
  The ranch child specs for `listeners`: keyword lists with `:port`, and optionally `:tls`, `:proxy_protocol`,
  `:ip`, `:acceptors`, `:max_connections`, `:handshake_timeout_ms`, `:name` (the listener's reference, default the
  port).
  """
  @spec child_specs([keyword()], keyword(), keyword()) :: [Supervisor.child_spec()]
  def child_specs(listeners, tls, protocol_opts) do
    for listener <- listeners do
      port = Keyword.fetch!(listener, :port)
      tls? = Keyword.get(listener, :tls, false)

      socket_opts =
        [port: port] ++ ip(listener) ++ @socket_defaults ++ if(tls?, do: tls_opts(tls), else: [])

      transport_opts = %{
        socket_opts: socket_opts,
        num_acceptors: Keyword.get(listener, :acceptors, 10),
        max_connections: Keyword.get(listener, :max_connections, 4_096),
        handshake_timeout: Keyword.get(listener, :handshake_timeout_ms, 10_000)
      }

      opts =
        Keyword.merge(protocol_opts,
          proxy_protocol: Keyword.get(listener, :proxy_protocol, false)
        )

      transport = if tls?, do: :ranch_ssl, else: :ranch_tcp

      :ranch.child_spec(
        ref(Keyword.get(listener, :name, port)),
        transport,
        transport_opts,
        Session,
        opts
      )
    end
  end

  defp ip(listener), do: if(ip = listener[:ip], do: [ip: ip], else: [])

  defp tls_opts(tls) do
    versions = Keyword.get(tls, :versions, @tls_versions)

    ciphers =
      versions
      |> Enum.flat_map(&:ssl.cipher_suites(:default, &1))
      |> Enum.uniq()

    [
      versions: versions,
      ciphers: ciphers,
      honor_cipher_order: true,
      secure_renegotiate: true,
      reuse_sessions: true
    ] ++ Keyword.take(tls, [:certfile, :keyfile, :cacertfile, :cert, :key, :password])
  end

  @doc "The ranch reference of a listener, by its `:name` (default its port)."
  @spec ref(term()) :: {Sms.Switch.Customer.Listener, term()}
  def ref(name), do: {__MODULE__, name}

  @doc "The port a listener actually listens on (useful with port 0 in tests)."
  @spec port(term()) :: :inet.port_number() | :undefined
  def port(ref), do: :ranch.get_port(ref)

  @doc "Stops accepting new connections on every listener (bound sessions stay)."
  @spec suspend_all() :: :ok
  def suspend_all, do: each_listener(&:ranch.suspend_listener/1)

  @doc "Accepts connections again on every listener."
  @spec resume_all() :: :ok
  def resume_all, do: each_listener(&:ranch.resume_listener/1)

  defp each_listener(fun) do
    for {{__MODULE__, _} = ref, _info} <- :ranch.info(), do: fun.(ref)
    :ok
  end
end
