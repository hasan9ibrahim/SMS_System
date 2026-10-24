defmodule Sms.Core.Bus.Subject do
  @moduledoc """
  NATS subject rules, shared by the adapters: tokens separated by dots; in a filter, `*` matches one token and `>`
  (last token only) matches one or more.
  """

  @doc "A subject events can be published to: `sms.` plus at least one token, no wildcards, no empty tokens."
  @spec valid_publish?(term()) :: boolean()
  def valid_publish?(subject) when is_binary(subject) do
    tokens = String.split(subject, ".")

    match?(["sms", _ | _], tokens) and
      Enum.all?(tokens, &valid_token?/1) and
      not Enum.any?(tokens, &(&1 in ["*", ">"]))
  end

  def valid_publish?(_), do: false

  @doc "A filter consumers can subscribe with."
  @spec valid_filter?(term()) :: boolean()
  def valid_filter?(filter) when is_binary(filter) do
    tokens = String.split(filter, ".")
    {init, [last]} = Enum.split(tokens, -1)

    Enum.all?(tokens, &(&1 == "*" or &1 == ">" or valid_token?(&1))) and ">" not in init and
      last != ""
  end

  def valid_filter?(_), do: false

  @doc "Whether `subject` matches `filter`."
  @spec matches?(String.t(), String.t()) :: boolean()
  def matches?(filter, subject),
    do: do_match(String.split(filter, "."), String.split(subject, "."))

  defp do_match([">"], [_ | _]), do: true
  defp do_match(["*" | f], [_ | s]), do: do_match(f, s)
  defp do_match([t | f], [t | s]), do: do_match(f, s)
  defp do_match([], []), do: true
  defp do_match(_, _), do: false

  defp valid_token?(t), do: t != "" and not String.contains?(t, [" ", "\t", "\r", "\n"])
end
