defmodule Sms.Switch.Voice do
  @moduledoc """
  SMS to voice (§8, decided with the product owner 2026-10-31, docs/SMS_TO_VOICE.md, S-6.9): a message that matches
  an active SMS-to-voice rule and carries a code (4 to 8 digits) is always a phone call instead of an SMS, placed by
  the server's own Asterisk through the rule's voice gateway, saying "Your verification code is" (or the rule's own
  recording) and the digits one by one, `repeat_count` times.

  The intake (`Sms.Switch.Pipeline.Intake`) asks `plan/1` after ingress translation, HLR and the customer's rate,
  before routing; a call skips routing, holds the credit of one message at the customer's rate and goes on its
  gateway's queue (`Sms.Switch.Voice.Calls`). The parts:

    * `Sms.Switch.Voice.Rules`: matching, the code, the gateway, the caller ID and the number dialled;
    * `Sms.Switch.Voice.AmiClient` and `Sms.Switch.Voice.Ami`: Asterisk's manager interface;
    * `Sms.Switch.Voice.Files`: the gateways' PJSIP file and the rules' recordings on this server;
    * `Sms.Switch.Voice.Calls`: the queues, `max_calls`, the retry, the receipts, billing and EDRs.

  Voice is on where `SMS_ASTERISK_AMI_HOST` is set (`config :sms_switch, Sms.Switch.Voice, ami_host: ...`). Where it
  is off, a matching message goes as an SMS and a warning is logged once. A Test SMS or Repush (an internal message)
  is never a call.
  """
  require Logger
  alias Sms.Switch.Pipeline.Config
  alias Sms.Switch.Voice.Rules

  @warned {__MODULE__, :warned}

  @doc "Whether voice is on on this server (an Asterisk to call through is configured)."
  @spec enabled?() :: boolean()
  def enabled?, do: settings()[:ami_host] not in [nil, ""]

  @doc "The voice settings (`config :sms_switch, Sms.Switch.Voice`)."
  @spec settings() :: keyword()
  def settings, do: Application.get_env(:sms_switch, __MODULE__, [])

  @doc "Asterisk's sounds directory on this server (`SMS_ASTERISK_SOUNDS_DIR`)."
  @spec sounds_dir() :: String.t()
  def sounds_dir, do: settings()[:sounds_dir] || "/usr/share/asterisk/sounds"

  @doc """
  Whether a message (after ingress translation, with its destination and rate) becomes a call: `{:call, call}`
  (`Sms.Switch.Voice.Rules.call()`), or `:sms` for the normal path.
  """
  @spec plan(map()) :: {:call, Rules.call()} | :sms
  def plan(%{internal: %{}}), do: :sms

  def plan(msg) do
    case Config.voice() do
      %{rules: []} ->
        :sms

      %{rules: rules, gateways: gateways} ->
        input = %{
          sender: msg.ingress[:sender],
          receiver: msg.ingress[:route_receiver] || "",
          mccmnc: (msg[:destination] || %{})[:mccmnc],
          text: msg.ingress[:text]
        }

        decide(Rules.plan(rules, gateways, input), msg)
    end
  end

  defp decide({:call, call}, msg) do
    if enabled?() do
      {:call, call}
    else
      warn_once(
        :disabled,
        "message #{msg.id} matches SMS-to-voice rule #{call.rule_id} but voice is off on this server " <>
          "(SMS_ASTERISK_AMI_HOST not set): it goes as an SMS, as will the next ones"
      )

      :sms
    end
  end

  defp decide({:sms, {:no_gateway, rule_id}}, msg) do
    warn_once(
      {:no_gateway, rule_id},
      "message #{msg.id} matches SMS-to-voice rule #{rule_id} but no voice gateway is active: it goes as an SMS"
    )

    :sms
  end

  defp decide({:sms, _why}, _msg), do: :sms

  @doc """
  A message as a call: the call it becomes (`voice`) and one unit (`parts` 1): it is billed and its credit held as
  one message at the customer's SMS rate, whatever its parts were.
  """
  @spec as_call(map(), Rules.call()) :: map()
  def as_call(msg, call), do: msg |> Map.put(:voice, call) |> Map.put(:parts, 1)

  defp warn_once(key, text) do
    warned = :persistent_term.get(@warned, MapSet.new())

    unless MapSet.member?(warned, key) do
      :persistent_term.put(@warned, MapSet.put(warned, key))
      Logger.warning(text)
    end
  end

  @doc false
  # Forgets the warnings given (tests).
  @spec reset_warnings() :: :ok
  def reset_warnings do
    _ = :persistent_term.erase(@warned)
    :ok
  end
end
