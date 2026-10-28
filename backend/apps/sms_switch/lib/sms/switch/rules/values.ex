defmodule Sms.Switch.Rules.Values do
  @moduledoc """
  Sender ID / receiver value rows of a route or translation rule (team trial round 8, §6.3, §6.4): any row matching
  is a hit. Each row has its own match (the whole value, its start or anywhere in it) and case. Same as the mock's
  `routing/values.ts`.
  """

  @type row :: %{value: String.t(), match: :is | :starts | :contains, match_case: boolean()}

  @matches %{"is" => :is, "starts" => :starts, "contains" => :contains}

  @doc "Rows from the stored jsonb (camelCase keys, as the screens save them); blank values are dropped."
  @spec from_json([map()] | nil) :: [row()]
  def from_json(rows) do
    for r <- rows || [], (r["value"] || "") != "" do
      %{
        value: r["value"],
        match: Map.get(@matches, r["match"], :is),
        match_case: r["matchCase"] != false
      }
    end
  end

  @doc "Whether any row matches the value."
  @spec hit?([row()], String.t()) :: boolean()
  def hit?(rows, value), do: Enum.any?(rows, &row_hit?(&1, value))

  defp row_hit?(%{match_case: true} = r, value), do: compare(r.match, value, r.value)

  defp row_hit?(r, value),
    do: compare(r.match, String.downcase(value), String.downcase(r.value))

  defp compare(:is, value, want), do: value == want
  defp compare(:starts, value, want), do: String.starts_with?(value, want)
  defp compare(:contains, value, want), do: String.contains?(value, want)

  @doc ~S|The rows as text for a test result: is "BANK" or starts with "44" (any case).|
  @spec text([row()]) :: String.t()
  def text(rows) do
    Enum.map_join(rows, " or ", fn r ->
      word = %{is: "is", starts: "starts with", contains: "contains"}[r.match]
      "#{word} \"#{r.value}\"#{if r.match_case, do: "", else: " (any case)"}"
    end)
  end
end
