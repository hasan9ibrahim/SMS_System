defmodule Sms.Switch.Message.Address do
  @moduledoc """
  Address checks (SMPP 3.4 §5.2.5–§5.2.6, docs/SMPP_SCENARIOS.md S-2.10, S-4.7): what a sender must be to go to a
  vendor, as the customer sent it and again after each translation.

    * TON 0–6 (unknown, international, national, network specific, subscriber number, alphanumeric, abbreviated);
    * NPI 0, 1, 3, 4, 6, 8, 9, 10, 14 or 18 (unknown, E.164, data, telex, land mobile, national, private, ERMES,
      internet, WAP client id);
    * a numeric sender (digits, an optional leading +) at most 20 digits, the most a submit_sm source_addr holds;
    * an alphanumeric one (anything else, or any sender with TON 5) at most 11 characters, printable ASCII, the most a
      handset shows.
  """

  @npis [0, 1, 3, 4, 6, 8, 9, 10, 14, 18]

  @doc "Whether `ton` is a type of number SMPP defines."
  @spec ton?(term()) :: boolean()
  def ton?(ton), do: ton in 0..6

  @doc "Whether `npi` is a numbering plan SMPP defines."
  @spec npi?(term()) :: boolean()
  def npi?(npi), do: npi in @npis

  @doc """
  What is wrong with a sender and its TON / NPI (nil: unset, taken as 0), as the SMPP status to answer, or nil when
  it can go: `:esme_rinvsrcton`, `:esme_rinvsrcnpi` or `:esme_rinvsrcadr`.
  """
  @spec source_problem(String.t() | nil, integer() | nil, integer() | nil) ::
          :esme_rinvsrcton | :esme_rinvsrcnpi | :esme_rinvsrcadr | nil
  def source_problem(sender, ton, npi) do
    cond do
      not ton?(ton || 0) -> :esme_rinvsrcton
      not npi?(npi || 0) -> :esme_rinvsrcnpi
      true -> sender_problem(sender, ton)
    end
  end

  defp sender_problem(sender, _ton) when sender in [nil, ""], do: :esme_rinvsrcadr

  defp sender_problem(sender, ton) do
    cond do
      ton == 5 or not Regex.match?(~r/\A\+?[0-9]+\z/, sender) -> alphanumeric(sender)
      digits(sender) > 20 -> :esme_rinvsrcadr
      true -> nil
    end
  end

  defp digits("+" <> rest), do: byte_size(rest)
  defp digits(sender), do: byte_size(sender)

  defp alphanumeric(sender) do
    if String.length(sender) <= 11 and Regex.match?(~r/\A[\x20-\x7E]+\z/, sender),
      do: nil,
      else: :esme_rinvsrcadr
  end

  @typedoc "A message's addresses and their TON / NPI (nil: not set)."
  @type addresses :: %{
          required(:sender) => String.t(),
          required(:receiver) => String.t(),
          required(:sender_ton) => non_neg_integer() | nil,
          required(:sender_npi) => non_neg_integer() | nil,
          required(:dest_ton) => non_neg_integer() | nil,
          required(:dest_npi) => non_neg_integer() | nil,
          optional(atom()) => term()
        }

  @typedoc "A TON / NPI field a translation rule can set."
  @type ton_npi_field :: :sender_ton | :sender_npi | :dest_ton | :dest_npi

  @doc """
  The addresses as a trunk set to automatic TON / NPI sends them (S-4.7, contract `TonNpiMode`), from the addresses
  as they stand after its translation (ingress on a customer trunk, egress on a vendor trunk):

    * source: `+` then digits → the `+` taken off, TON 1 / NPI 1; 9 or more digits → TON 1 / NPI 1; 3–8 digits (a
      short code) → TON 3 / NPI 0; anything else but 1–2 digits (alphanumeric) → TON 5 / NPI 0. A length or
      characters cannot be fixed: `source_problem/3` still refuses an alphanumeric sender over 11 characters;
    * destination: a full international number (8–15 digits, an optional leading `+` taken off) → TON 1 / NPI 1;
      anything else as it is.

  `pinned`: the fields a translation rule set; they win over auto, and the `+` stays on an address whose TON a rule
  set. Mirrored by `mock/src/routing/tonNpi.ts` for the Route Simulator.
  """
  @spec auto(addresses(), Enumerable.t(ton_npi_field())) :: addresses()
  def auto(addresses, pinned \\ []) do
    pinned = MapSet.new(pinned)

    addresses
    |> fix(fix_source(addresses.sender), {:sender, :sender_ton, :sender_npi}, pinned)
    |> fix(fix_destination(addresses.receiver), {:receiver, :dest_ton, :dest_npi}, pinned)
  end

  defp fix(a, nil, _fields, _pinned), do: a

  defp fix(a, {address, ton, npi}, {address_key, ton_key, npi_key}, pinned) do
    a = if ton_key in pinned, do: a, else: %{a | address_key => address, ton_key => ton}
    if npi_key in pinned, do: a, else: %{a | npi_key => npi}
  end

  defp fix_source("+" <> digits = sender) do
    if Regex.match?(~r/\A[0-9]+\z/, digits), do: {digits, 1, 1}, else: {sender, 5, 0}
  end

  defp fix_source(sender) when is_binary(sender) and sender != "" do
    cond do
      not Regex.match?(~r/\A[0-9]+\z/, sender) -> {sender, 5, 0}
      byte_size(sender) >= 9 -> {sender, 1, 1}
      byte_size(sender) >= 3 -> {sender, 3, 0}
      true -> nil
    end
  end

  defp fix_source(_sender), do: nil

  defp fix_destination(receiver) when is_binary(receiver) do
    if Regex.match?(~r/\A\+?[0-9]{8,15}\z/, receiver),
      do: {String.trim_leading(receiver, "+"), 1, 1},
      else: nil
  end

  defp fix_destination(_receiver), do: nil
end
