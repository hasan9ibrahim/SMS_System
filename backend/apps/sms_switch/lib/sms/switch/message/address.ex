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
      sender in [nil, ""] -> :esme_rinvsrcadr
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
end
