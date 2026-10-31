defmodule Sms.Switch.Customer.Trunk do
  @moduledoc """
  The settings of one SMPP customer trunk that the customer side needs (spec §5.4, §13.1), as loaded from
  `customer_trunks` by `Sms.Switch.Customer.Loader`.

  `tps` is per session (bind), so the trunk's shared limit across both servers is `tps × max_connections`
  (migration 034, decision Q13). `company_tps_limit` is the business company's limit on top (S-2.4), `nil` for none.
  """
  alias Sms.Switch.Customer.IpRange
  alias Sms.Switch.Throttle

  @enforce_keys [:id, :username, :password]
  defstruct [
    :id,
    :enterprise_id,
    :business_company_id,
    :company_tps_limit,
    :name,
    :username,
    :password,
    :system_type,
    :port,
    status: :active,
    bind_type: :auto,
    host_ips: [],
    max_connections: 1,
    tls: :none,
    tps: 1,
    overflow_buffer: 0,
    dlr_session_affinity: :strict,
    dlr_hold_hours: 72,
    delayed_submit: false
  ]

  @type bind_type :: :tx | :rx | :trx | :auto
  @type tls :: :none | :"tls1.0" | :"tls1.2" | :"tls1.3"
  @type affinity :: :strict | :same_ip | :same_trunk

  @type t :: %__MODULE__{
          id: pos_integer(),
          enterprise_id: pos_integer() | nil,
          business_company_id: pos_integer() | nil,
          company_tps_limit: pos_integer() | nil,
          name: String.t() | nil,
          username: String.t(),
          password: String.t(),
          system_type: String.t() | nil,
          port: :inet.port_number() | nil,
          status: :active | :inactive,
          bind_type: bind_type(),
          host_ips: [IpRange.t()],
          max_connections: pos_integer(),
          tls: tls(),
          tps: pos_integer(),
          overflow_buffer: non_neg_integer(),
          dlr_session_affinity: affinity(),
          dlr_hold_hours: non_neg_integer(),
          delayed_submit: boolean()
        }

  @doc "The trunk's TPS limit shared by all its sessions on every server."
  @spec trunk_tps(t()) :: integer()
  def trunk_tps(%__MODULE__{tps: tps, max_connections: max})
      when is_integer(tps) and is_integer(max),
      do: tps * max

  @doc "The TPS counters a submit on this trunk must fit in (`Sms.Switch.Throttle`): the trunk's, then the company's."
  @spec tps_counters(t()) :: [Sms.Switch.Throttle.counter()]
  def tps_counters(%__MODULE__{} = trunk) do
    company =
      if trunk.company_tps_limit,
        do: [{:company_tps, "bc:#{trunk.business_company_id}", trunk.company_tps_limit}],
        else: []

    [{:trunk_tps, "ct:#{trunk.id}", trunk_tps(trunk)} | company]
  end

  @doc "The key of the trunk's overflow buffer count (`Sms.Switch.Throttle.buffer_take/2`, S-2.4)."
  @spec buffer_key(t() | pos_integer()) :: String.t()
  def buffer_key(%__MODULE__{id: id}), do: buffer_key(id)
  def buffer_key(id) when is_integer(id), do: "ct:#{id}"

  @doc """
  Whether one more message fits on the trunk in `second` (S-2.4): within its TPS and its company's (`:ok`, counted), over
  it with a place taken in its overflow buffer (`:buffered`), or neither (`:full`). Asked by the session for each submit,
  and again for a scheduled message when its time comes (`Sms.Switch.Pipeline.Scheduled`, S-2.12).
  """
  @spec admit(t(), integer()) :: :ok | :buffered | :full
  def admit(%__MODULE__{} = trunk, second \\ System.os_time(:second)) do
    cond do
      Throttle.acquire(tps_counters(trunk), second) == :ok -> :ok
      Throttle.buffer_take(buffer_key(trunk), trunk.overflow_buffer) -> :buffered
      true -> :full
    end
  end

  @doc "Gives back what `admit/2` took in `second` for a message that did not go after all."
  @spec unadmit(t(), :ok | :buffered, integer()) :: :ok
  def unadmit(%__MODULE__{} = trunk, :ok, second),
    do: Throttle.release(tps_counters(trunk), second)

  def unadmit(%__MODULE__{} = trunk, :buffered, _second),
    do: Throttle.buffer_release(buffer_key(trunk))

  @doc "Whether a client at `ip` may bind (spec §5.4 Host Name)."
  @spec ip_allowed?(t(), :inet.ip_address()) :: boolean()
  def ip_allowed?(%__MODULE__{host_ips: ranges}, ip), do: IpRange.member?(ranges, ip)

  @doc "Whether the trunk accepts a bind of this kind (S-1.3): AUTO accepts TX, RX and TRX."
  @spec bind_allowed?(t(), :tx | :rx | :trx) :: boolean()
  def bind_allowed?(%__MODULE__{bind_type: :auto}, _kind), do: true
  def bind_allowed?(%__MODULE__{bind_type: kind}, kind), do: true
  def bind_allowed?(%__MODULE__{}, _kind), do: false

  @doc """
  Whether a connection's transport meets the trunk's SSLType (S-1.17): a plain trunk accepts plain connections and
  TLS ones; a TLS trunk needs TLS at its version or newer. `negotiated` is `nil` for a plain connection.
  """
  @spec transport_allowed?(t(), :"tlsv1.3" | :"tlsv1.2" | :"tlsv1.1" | :tlsv1 | nil) :: boolean()
  def transport_allowed?(%__MODULE__{tls: :none}, _negotiated), do: true
  def transport_allowed?(%__MODULE__{}, nil), do: false

  def transport_allowed?(%__MODULE__{tls: required}, negotiated),
    do: rank(negotiated) >= rank(required)

  defp rank(:tlsv1), do: 10
  defp rank(:"tls1.0"), do: 10
  defp rank(:"tlsv1.1"), do: 11
  defp rank(:"tlsv1.2"), do: 12
  defp rank(:"tls1.2"), do: 12
  defp rank(:"tlsv1.3"), do: 13
  defp rank(:"tls1.3"), do: 13

  @doc "Whether the password matches, in constant time (no timing hint about how much of it matched)."
  @spec password_ok?(t(), String.t()) :: boolean()
  def password_ok?(%__MODULE__{password: expected}, given) when is_binary(given),
    do: :crypto.hash_equals(:crypto.hash(:sha256, expected), :crypto.hash(:sha256, given))
end
