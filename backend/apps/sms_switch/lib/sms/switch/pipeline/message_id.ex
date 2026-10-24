defmodule Sms.Switch.Pipeline.MessageId do
  @moduledoc """
  The message_id the switch gives a customer in submit_sm_resp (S-2.5): unique across both servers and restarts,
  time-ordered, 20 lower-case hex characters (well within SMPP's 64).

  Layout: 48 bits of Unix time in milliseconds, 8 bits of node id (`config :sms_switch, Sms.Switch.Pipeline,
  node_id: 0..255`, a different one per server), 24 bits of a counter that never resets while the node runs. Two ids
  collide only if one node makes 16.7 million in one millisecond.
  """
  import Bitwise

  @counter {__MODULE__, :counter}

  @doc "A new message id."
  @spec new() :: String.t()
  def new do
    ms = System.os_time(:millisecond) &&& 0xFFFFFFFFFFFF
    seq = :atomics.add_get(counter(), 1, 1) &&& 0xFFFFFF
    Base.encode16(<<ms::48, node_id()::8, seq::24>>, case: :lower)
  end

  @doc "The time (Unix ms) and node an id was made on."
  @spec decode(String.t()) :: {:ok, %{ms: non_neg_integer(), node_id: 0..255}} | :error
  def decode(id) when byte_size(id) == 20 do
    case Base.decode16(id, case: :lower) do
      {:ok, <<ms::48, node::8, _seq::24>>} -> {:ok, %{ms: ms, node_id: node}}
      _ -> :error
    end
  end

  def decode(_id), do: :error

  defp node_id do
    case :sms_switch
         |> Application.get_env(Sms.Switch.Pipeline, [])
         |> Keyword.get(:node_id, 0) do
      id when id in 0..255 -> id
    end
  end

  @doc false
  # Creates the counter once, when the application starts (before any message), so no two processes ever race to
  # make it.
  @spec setup() :: :ok
  def setup do
    if :persistent_term.get(@counter, nil) == nil,
      do: :persistent_term.put(@counter, :atomics.new(1, signed: false))

    :ok
  end

  defp counter, do: :persistent_term.get(@counter)
end
