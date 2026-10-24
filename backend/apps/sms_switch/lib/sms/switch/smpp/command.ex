defmodule Sms.Switch.Smpp.Command do
  @moduledoc """
  SMPP 3.4 command ids (spec §5.1.2.1). A response id is its request id with the top bit set.
  """
  import Bitwise

  @commands [
    generic_nack: 0x80000000,
    bind_receiver: 0x00000001,
    bind_receiver_resp: 0x80000001,
    bind_transmitter: 0x00000002,
    bind_transmitter_resp: 0x80000002,
    query_sm: 0x00000003,
    query_sm_resp: 0x80000003,
    submit_sm: 0x00000004,
    submit_sm_resp: 0x80000004,
    deliver_sm: 0x00000005,
    deliver_sm_resp: 0x80000005,
    unbind: 0x00000006,
    unbind_resp: 0x80000006,
    replace_sm: 0x00000007,
    replace_sm_resp: 0x80000007,
    cancel_sm: 0x00000008,
    cancel_sm_resp: 0x80000008,
    bind_transceiver: 0x00000009,
    bind_transceiver_resp: 0x80000009,
    outbind: 0x0000000B,
    enquire_link: 0x00000015,
    enquire_link_resp: 0x80000015,
    submit_multi: 0x00000021,
    submit_multi_resp: 0x80000021,
    alert_notification: 0x00000102,
    data_sm: 0x00000103,
    data_sm_resp: 0x80000103
  ]

  @by_id Map.new(@commands, fn {name, id} -> {id, name} end)
  @by_name Map.new(@commands)

  @type t ::
          :generic_nack
          | :bind_receiver
          | :bind_receiver_resp
          | :bind_transmitter
          | :bind_transmitter_resp
          | :query_sm
          | :query_sm_resp
          | :submit_sm
          | :submit_sm_resp
          | :deliver_sm
          | :deliver_sm_resp
          | :unbind
          | :unbind_resp
          | :replace_sm
          | :replace_sm_resp
          | :cancel_sm
          | :cancel_sm_resp
          | :bind_transceiver
          | :bind_transceiver_resp
          | :outbind
          | :enquire_link
          | :enquire_link_resp
          | :submit_multi
          | :submit_multi_resp
          | :alert_notification
          | :data_sm
          | :data_sm_resp

  @doc "Every command name."
  @spec all() :: [t()]
  def all, do: Keyword.keys(@commands)

  @spec id(t()) :: non_neg_integer()
  def id(name), do: Map.fetch!(@by_name, name)

  @spec name(non_neg_integer()) :: {:ok, t()} | :error
  def name(id), do: Map.fetch(@by_id, id)

  @doc "Whether the command is a response (generic_nack counts as one)."
  @spec response?(t()) :: boolean()
  def response?(name), do: (id(name) &&& 0x80000000) != 0

  @doc "The response to a request, e.g. `:submit_sm` → `:submit_sm_resp`. Requests without one return nil."
  @spec response(t()) :: t() | nil
  def response(name) when name in [:outbind, :alert_notification], do: nil

  def response(name) do
    if response?(name), do: nil, else: Map.fetch!(@by_id, id(name) ||| 0x80000000)
  end
end
