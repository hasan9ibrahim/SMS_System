defmodule Sms.Switch.Vendor.Trunk do
  @moduledoc """
  The settings of one SMPP vendor trunk that the vendor side needs (spec §5.5, migration 058 bind policy), as loaded
  from `vendor_trunks` by `Sms.Switch.Vendor.Loader`.

  `tps` is per session, so the trunk's limit shared by both servers is `tps × max_connections` (migration 034,
  decision Q12). The capability filters (allowed codings, TON/NPI, max length, multipart) belong to routing (step 4).
  """

  @enforce_keys [:id, :host, :port, :username, :password]
  defstruct [
    :id,
    :enterprise_id,
    :name,
    :host,
    :port,
    :source_host,
    :username,
    :password,
    :system_type,
    :service_type,
    :bind_addr_range,
    status: :active,
    bind_type: :trx,
    max_connections: 1,
    tls: :none,
    tps: 1,
    window_size: 10,
    overflow_buffer: 0,
    submit_interval_ms: 0,
    submit_timeout_s: 30,
    enquire_link_interval_s: 30,
    enquire_link_timeout_s: 30,
    reconnect_schedule_s: [5, 10, 30, 60],
    bind_alert_after_min: 2,
    auth_fail_retry_min: 15,
    msg_id_type: :default,
    bind_addr_ton: 0,
    bind_addr_npi: 0
  ]

  @type t :: %__MODULE__{
          id: pos_integer(),
          enterprise_id: pos_integer() | nil,
          name: String.t() | nil,
          host: String.t(),
          port: :inet.port_number(),
          source_host: :inet.ip_address() | nil,
          username: String.t(),
          password: String.t(),
          system_type: String.t() | nil,
          service_type: String.t() | nil,
          bind_addr_range: String.t() | nil,
          status: :active | :inactive,
          bind_type: :tx | :rx | :trx,
          max_connections: pos_integer(),
          tls: :none | :"tls1.0" | :"tls1.2" | :"tls1.3",
          tps: pos_integer(),
          window_size: pos_integer(),
          overflow_buffer: non_neg_integer(),
          submit_interval_ms: non_neg_integer(),
          submit_timeout_s: pos_integer(),
          enquire_link_interval_s: pos_integer(),
          enquire_link_timeout_s: pos_integer(),
          reconnect_schedule_s: [pos_integer()],
          bind_alert_after_min: pos_integer(),
          auth_fail_retry_min: pos_integer(),
          msg_id_type: :default | :decimal | :hexadecimal,
          bind_addr_ton: non_neg_integer(),
          bind_addr_npi: non_neg_integer()
        }

  @doc "The trunk's TPS limit shared by all its sessions on every server."
  @spec trunk_tps(t()) :: integer()
  def trunk_tps(%__MODULE__{tps: tps, max_connections: max})
      when is_integer(tps) and is_integer(max),
      do: tps * max

  @doc "The TPS counter a submit to this vendor must fit in (`Sms.Switch.Throttle`)."
  @spec tps_counters(t()) :: [Sms.Switch.Throttle.counter()]
  def tps_counters(%__MODULE__{} = trunk), do: [{:vendor_tps, "vt:#{trunk.id}", trunk_tps(trunk)}]

  @doc """
  Whether a change between two versions of a trunk needs its connections opened again (where and how they connect
  and bind). Other changes (TPS, window, timeouts) apply to live sessions in place.
  """
  @spec reconnect_needed?(t(), t()) :: boolean()
  def reconnect_needed?(%__MODULE__{} = old, %__MODULE__{} = new) do
    fields =
      [:host, :port, :source_host, :username, :password, :system_type, :bind_type, :tls] ++
        [:bind_addr_ton, :bind_addr_npi, :bind_addr_range]

    Enum.any?(fields, &(Map.fetch!(old, &1) != Map.fetch!(new, &1)))
  end

  @doc "The wait before reconnect attempt `n` (0-based): the schedule's `n`th value, the last one repeating."
  @spec reconnect_delay_ms(t(), non_neg_integer()) :: pos_integer()
  def reconnect_delay_ms(%__MODULE__{reconnect_schedule_s: schedule}, n) do
    case Enum.at(schedule, min(n, length(schedule) - 1)) do
      seconds when is_integer(seconds) and seconds > 0 -> seconds * 1_000
      # An empty schedule (the loader never gives one).
      _ -> 5_000
    end
  end
end
