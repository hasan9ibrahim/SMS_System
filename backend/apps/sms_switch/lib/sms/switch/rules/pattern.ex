defmodule Sms.Switch.Rules.Pattern do
  @moduledoc """
  The patterns the screens save on route and translation rules (§6.3, §6.4) are JavaScript regular expressions; the
  mock evaluates them with JavaScript and the switch with PCRE. This module keeps the two in step:

    * the sender keywords `\\Numeric` (digits only, optional leading +) and `\\Alpha` (has a letter), team trial
      round 2;
    * case-sensitive unless told otherwise, Unicode text (UTF-8), `\\d` and `\\w` ASCII as in JavaScript;
    * replacement strings with JavaScript's `$1`..`$99`, `$&`, `` $` ``, `$'` and `$$`;
    * an invalid pattern never raises: it compiles to `:invalid` and never matches (the screens reject it on save).
  """

  @type t :: Regex.t() | :invalid

  @doc "Compiles a saved pattern; `match_case: false` ignores case."
  @spec compile(String.t(), keyword()) :: t()
  def compile(pattern, opts \\ []) when is_binary(pattern) do
    source = keyword(pattern) || pattern
    flags = if Keyword.get(opts, :match_case, true), do: [:unicode], else: [:unicode, :caseless]

    case Regex.compile(source, flags) do
      {:ok, regex} -> regex
      {:error, _} -> :invalid
    end
  end

  @doc "The regular expression behind a sender keyword, or nil."
  @spec keyword(String.t()) :: String.t() | nil
  def keyword(pattern) do
    case pattern |> String.trim() |> String.downcase() do
      "\\numeric" -> "^\\+?[0-9]+$"
      "\\alpha" -> "[A-Za-z]"
      _ -> nil
    end
  end

  @doc "Whether the pattern matches anywhere in `value` (JavaScript `RegExp.test`)."
  @spec match?(t(), String.t()) :: boolean()
  def match?(:invalid, _value), do: false
  def match?(regex, value), do: Regex.match?(regex, value)

  @doc """
  Replaces every match (JavaScript `String.replace` with a global pattern). `fun` gets the match and its groups as
  binaries, `nil` for a group that did not take part, plus the text before and after the match.
  """
  @spec replace(t(), String.t(), (String.t(), [String.t() | nil], String.t(), String.t() ->
                                    String.t())) ::
          String.t()
  def replace(:invalid, input, _fun), do: input
  def replace(regex, input, fun), do: replace_from(regex, input, 0, fun, [])

  defp replace_from(regex, input, from, fun, acc) do
    found =
      if from <= byte_size(input),
        do: :re.run(input, regex.re_pattern, [{:offset, from}, {:capture, :all, :index}]),
        else: :nomatch

    case found do
      {:match, [{start, len} | groups]} ->
        values =
          Enum.map(groups, fn {s, l} -> if s < 0, do: nil, else: binary_part(input, s, l) end)

        before = binary_part(input, 0, start)
        after_ = binary_part(input, start + len, byte_size(input) - start - len)

        acc = [
          fun.(binary_part(input, start, len), values, before, after_),
          binary_part(input, from, start - from) | acc
        ]

        if len > 0,
          do: replace_from(regex, input, start + len, fun, acc),
          else: after_empty(regex, input, start, fun, acc)

      :nomatch ->
        rest =
          if from < byte_size(input),
            do: binary_part(input, from, byte_size(input) - from),
            else: ""

        IO.iodata_to_binary(Enum.reverse([rest | acc]))
    end
  end

  # After an empty match, the next character is copied as is and the search goes on after it (as JavaScript does).
  defp after_empty(regex, input, at, fun, acc) do
    case String.next_codepoint(binary_part(input, at, byte_size(input) - at)) do
      {char, _rest} -> replace_from(regex, input, at + byte_size(char), fun, [char | acc])
      nil -> IO.iodata_to_binary(Enum.reverse(acc))
    end
  end

  @doc "Replaces every match with a JavaScript replacement string (`$1`, `$&`, `$$`…)."
  @spec replace_js(t(), String.t(), String.t()) :: String.t()
  def replace_js(regex, input, replacement) do
    replace(regex, input, fn match, groups, before, after_ ->
      expand(replacement, match, groups, before, after_)
    end)
  end

  @doc false
  # JavaScript's GetSubstitution: $$, $&, $`, $', $n and $nn (the two-digit form when that group exists).
  def expand(replacement, match, groups, before, after_),
    do: expand(replacement, match, groups, before, after_, [])

  defp expand(<<>>, _m, _g, _b, _a, acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()
  defp expand(<<"$$", rest::binary>>, m, g, b, a, acc), do: expand(rest, m, g, b, a, ["$" | acc])
  defp expand(<<"$&", rest::binary>>, m, g, b, a, acc), do: expand(rest, m, g, b, a, [m | acc])
  defp expand(<<"$`", rest::binary>>, m, g, b, a, acc), do: expand(rest, m, g, b, a, [b | acc])
  defp expand(<<"$'", rest::binary>>, m, g, b, a, acc), do: expand(rest, m, g, b, a, [a | acc])

  defp expand(<<"$", d1, d2, rest::binary>>, m, g, b, a, acc)
       when d1 in ?0..?9 and d2 in ?0..?9 do
    two = (d1 - ?0) * 10 + (d2 - ?0)

    cond do
      two >= 1 and two <= length(g) -> expand(rest, m, g, b, a, [Enum.at(g, two - 1) || "" | acc])
      true -> expand(<<d2, rest::binary>>, m, g, b, a, one(d1, m, g, acc))
    end
  end

  defp expand(<<"$", d1, rest::binary>>, m, g, b, a, acc) when d1 in ?0..?9,
    do: expand(rest, m, g, b, a, one(d1, m, g, acc))

  defp expand(<<c::utf8, rest::binary>>, m, g, b, a, acc),
    do: expand(rest, m, g, b, a, [<<c::utf8>> | acc])

  # $n for a group that exists (empty when it did not take part); otherwise the text stays as typed.
  defp one(d, _m, g, acc) do
    n = d - ?0
    if n >= 1 and n <= length(g), do: [Enum.at(g, n - 1) || "" | acc], else: [<<?$, d>> | acc]
  end

  @doc "Length in UTF-16 code units, as JavaScript's `String.length` (the screens' length limits)."
  @spec js_length(String.t()) :: non_neg_integer()
  def js_length(text),
    do: text |> String.to_charlist() |> Enum.reduce(0, &(&2 + if(&1 > 0xFFFF, do: 2, else: 1)))
end
