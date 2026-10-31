defmodule Sms.Switch.Voice.Rules do
  @moduledoc """
  Which messages become a phone call and how it is placed (§8 SMS to voice, docs/SMS_TO_VOICE.md, S-6.9). Pure: the
  rules and gateways come from the routing snapshot (`Sms.Switch.Pipeline.Config.voice/0`).

    * **Match:** the active rules in order of id; a rule matches when every field it sets matches the message after
      ingress translation: Sender ID (the sender) and Receiver ID (the receiver number) with `%` / `_` wildcards in
      any case, as the screens' Test does (mock `likeMatch`); Prefix (the receiver number starts with it); Destination
      (the receiver's MCCMNC as routing resolves it, HLR included). Empty fields match anything.
    * **Code:** the first run of 4 to 8 digits in the text. No code: the message goes as a normal SMS.
    * **Gateway:** the rule's own when it is active, else the active gateway with the lowest priority (then id).
    * **Caller ID:** the sender when it is a number (digits, optional leading `+`), else the gateway's fixed caller
      ID; a gateway set to `fixed` always uses its fixed caller ID.
    * **Number dialled:** the gateway's dial prefix and the receiver's digits.
  """

  @typedoc "A rule as loaded: its condition patterns compiled."
  @type rule :: %{
          required(:id) => integer(),
          required(:sender) => Regex.t() | nil,
          required(:receiver) => Regex.t() | nil,
          required(:prefix) => String.t() | nil,
          required(:mccmnc) => String.t() | nil,
          required(:repeat) => pos_integer(),
          required(:gateway_id) => integer() | nil,
          required(:prompt) => String.t() | nil
        }

  @typedoc "A voice gateway as loaded (the password decrypted)."
  @type gateway :: %{
          required(:id) => integer(),
          required(:priority) => integer(),
          required(:caller_id_mode) => :sender | :fixed,
          required(:fixed_caller_id) => String.t() | nil,
          required(:dial_prefix) => String.t(),
          optional(atom()) => term()
        }

  @typedoc "What the message is checked with: after ingress translation, the receiver as digits."
  @type input :: %{
          sender: String.t() | nil,
          receiver: String.t(),
          mccmnc: String.t() | nil,
          text: String.t() | nil
        }

  @typedoc "A call to place: never written to an EDR as such (the code is not stored)."
  @type call :: %{
          rule_id: integer(),
          gateway_id: integer(),
          code: String.t(),
          repeat: pos_integer(),
          dial: String.t(),
          caller_id: String.t() | nil,
          prompt: String.t() | nil
        }

  @code ~r/(?<![0-9])[0-9]{4,8}(?![0-9])/
  @number ~r/\A\+?[0-9]+\z/

  @doc """
  What happens to a message: `{:call, call}`, or why it goes as an SMS (`:no_rule`, `:no_code`, or
  `{:no_gateway, rule_id}` when a rule matches but no gateway is active).
  """
  @spec plan([rule()], %{integer() => gateway()}, input()) ::
          {:call, call()} | {:sms, :no_rule | :no_code | {:no_gateway, integer()}}
  def plan(rules, gateways, input) do
    with {:rule, %{} = rule} <- {:rule, match(rules, input)},
         {:code, code} when is_binary(code) <- {:code, code(input.text)} do
      case gateway(rule, gateways) do
        nil -> {:sms, {:no_gateway, rule.id}}
        gateway -> {:call, call(rule, gateway, code, input)}
      end
    else
      {:rule, nil} -> {:sms, :no_rule}
      {:code, nil} -> {:sms, :no_code}
    end
  end

  defp call(rule, gateway, code, input) do
    %{
      rule_id: rule.id,
      gateway_id: gateway.id,
      code: code,
      repeat: rule.repeat,
      dial: dial(gateway, input.receiver),
      caller_id: caller_id(gateway, input.sender),
      prompt: rule.prompt
    }
  end

  @doc "The first rule (lowest id first, as given) whose every set field matches, or nil."
  @spec match([rule()], input()) :: rule() | nil
  def match(rules, input), do: Enum.find(rules, &matches?(&1, input))

  defp matches?(rule, input) do
    like?(rule.sender, input.sender || "") and like?(rule.receiver, input.receiver) and
      prefix?(rule.prefix, input.receiver) and mccmnc?(rule.mccmnc, input.mccmnc)
  end

  defp like?(nil, _value), do: true
  defp like?(regex, value), do: Regex.match?(regex, value)

  defp prefix?(nil, _receiver), do: true
  defp prefix?(prefix, receiver), do: String.starts_with?(receiver, prefix)

  defp mccmnc?(nil, _mccmnc), do: true
  defp mccmnc?(code, mccmnc), do: code == mccmnc

  @doc """
  A rule pattern with `%` (any characters) and `_` (one character), whole value and any case (§13.25 wildcards, mock
  `likeMatch`); nil for an empty pattern (matches anything).
  """
  @spec like(String.t() | nil) :: Regex.t() | nil
  def like(pattern) when pattern in [nil, ""], do: nil

  def like(pattern) do
    source =
      pattern
      |> String.graphemes()
      |> Enum.map_join(fn
        "%" -> ".*"
        "_" -> "."
        c -> Regex.escape(c)
      end)

    Regex.compile!("\\A" <> source <> "\\z", "iu")
  end

  @doc "The code to read out: the first run of 4 to 8 digits in the text, or nil."
  @spec code(String.t() | nil) :: String.t() | nil
  def code(nil), do: nil

  def code(text) do
    case Regex.run(@code, text) do
      [code] when is_binary(code) -> code
      _ -> nil
    end
  end

  @doc "The rule's gateway when active (in `gateways`), else the active one with the lowest priority, then id."
  @spec gateway(rule(), %{integer() => gateway()}) :: gateway() | nil
  def gateway(rule, gateways) do
    case rule.gateway_id && Map.get(gateways, rule.gateway_id) do
      %{} = gateway -> gateway
      _ -> gateways |> Map.values() |> Enum.min_by(&{&1.priority, &1.id}, fn -> nil end)
    end
  end

  @doc "The caller ID the called person sees (nil: Asterisk's default)."
  @spec caller_id(gateway(), String.t() | nil) :: String.t() | nil
  def caller_id(%{caller_id_mode: :fixed} = gateway, _sender), do: blank(gateway.fixed_caller_id)

  def caller_id(gateway, sender) do
    if is_binary(sender) and Regex.match?(@number, sender),
      do: sender,
      else: blank(gateway.fixed_caller_id)
  end

  defp blank(value) when value in [nil, ""], do: nil
  defp blank(value), do: value

  @doc "The number dialled: the gateway's dial prefix (digits, `+`, `*`, `#` only) and the receiver's digits."
  @spec dial(gateway(), String.t()) :: String.t()
  def dial(gateway, receiver) do
    String.replace(gateway.dial_prefix || "", ~r/[^0-9+*#]/, "") <>
      String.replace(receiver, ~r/[^0-9]/, "")
  end
end
