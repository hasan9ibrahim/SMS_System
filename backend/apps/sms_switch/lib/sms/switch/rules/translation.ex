defmodule Sms.Switch.Rules.Translation do
  @moduledoc """
  The translation engine (spec §6.4, §13.2): runs a message through a trunk's translation rules, in the trunk's order,
  and reports every check and change. A port of the mock's `mock/src/routing/translate.ts`, with its tests, so the
  rule Test and Route Simulator on the screens and the switch give the same answer.

  Pure: number lists, the receiver's network, the time and randomness come in through `Context`. Rules are built
  once with `Rule.new/1` (patterns compiled) when the switch loads its configuration.

  A rule matches when every condition it sets holds (none set: it always matches). A matched rule either blocks the
  message (the run ends, the message is refused) or applies its changes in this order: sender conversion, receiver
  conversion (the network follows the new receiver), TON / NPI, billing type, registered delivery, DLR status map,
  then the content rewrite (words, regex, template). A matched rule set to Stop ends the run; Continue goes on with
  the changed message (S-4.8).
  """
  alias Sms.Switch.Rules.{Pattern, Values}

  defmodule Rule do
    @moduledoc "One translation rule, with its patterns compiled."

    @fields [
      :id,
      :name,
      action: :allow,
      status: :active,
      continue_after: true,
      sender_pattern: nil,
      sender_pattern_negate: false,
      sender_match_case: true,
      receiver_pattern: nil,
      receiver_pattern_negate: false,
      sender_values: [],
      receiver_values: [],
      mccmncs: [],
      mccmnc_negate: false,
      mccmnc_pattern: nil,
      content_pattern: nil,
      content_pattern_negate: false,
      sender_list_id: nil,
      sender_list_negate: false,
      receiver_list_id: nil,
      receiver_list_negate: false,
      sender_conversion: nil,
      sender_conversion_value: nil,
      sender_conversion_replacement: nil,
      sender_conversion_list_id: nil,
      receiver_conversion: nil,
      receiver_conversion_value: nil,
      receiver_conversion_replacement: nil,
      sender_ton: nil,
      sender_npi: nil,
      dest_ton: nil,
      dest_npi: nil,
      billing_type: nil,
      registered_delivery: nil,
      dlr_map: [],
      content_regex: nil,
      content_regex_index: nil,
      content_replacement: nil,
      msg_template: nil,
      content_words: [],
      content_number_format: nil,
      content_number_min_digits: nil,
      sender_min_length: 0,
      sender_max_length: 20,
      receiver_min_length: 0,
      receiver_max_length: 20,
      starts_at: nil,
      stops_at: nil
    ]
    defstruct @fields ++ [compiled: %{}]

    @type conversion ::
            :left_strip | :right_strip | :prepend | :append | :translation | :regex_replace
    @type t :: %__MODULE__{}

    @doc "A rule from its fields (atoms as in the struct); compiles every pattern it uses."
    @spec new(map() | keyword()) :: t()
    def new(fields) do
      rule = struct!(__MODULE__, fields)
      %{rule | mccmncs: MapSet.new(rule.mccmncs), compiled: compile(rule)}
    end

    defp compile(r) do
      %{
        sender:
          r.sender_pattern &&
            Pattern.compile(r.sender_pattern, match_case: r.sender_match_case != false),
        receiver: r.receiver_pattern && Pattern.compile(r.receiver_pattern),
        mccmnc: r.mccmnc_pattern && Pattern.compile(r.mccmnc_pattern),
        content: r.content_pattern && Pattern.compile(r.content_pattern),
        content_regex: r.content_regex && Pattern.compile(r.content_regex),
        sender_conversion: conversion_regex(r.sender_conversion, r.sender_conversion_value),
        receiver_conversion: conversion_regex(r.receiver_conversion, r.receiver_conversion_value),
        words: Enum.map(r.content_words, &word_regex/1)
      }
    end

    defp conversion_regex(:regex_replace, value), do: Pattern.compile(value || "")
    defp conversion_regex(_kind, _value), do: false

    # Whole words (not part of a word, Unicode-aware) and exact case unless switched off (team trial round 1).
    defp word_regex(%{find: find} = w) when is_binary(find) and find != "" do
      escaped = Regex.escape(find)

      body =
        if Map.get(w, :whole_word) == false,
          do: escaped,
          else: "(?<![\\p{L}\\p{N}_])#{escaped}(?![\\p{L}\\p{N}_])"

      {Pattern.compile(body, match_case: Map.get(w, :match_case) != false), w}
    end

    defp word_regex(w), do: {nil, w}
  end

  defmodule Context do
    @moduledoc """
    What the engine needs from outside: `list_has?.(list_id, value, match_case)`, `list_entries.(list_id)`,
    `templates.(list_id, sender_id)` (a Sender ID template's contents), `mccmnc_of.(receiver)`, `now` and `rand`
    (0 ≤ x < 1).
    """
    @enforce_keys [:list_has?, :list_entries, :mccmnc_of]
    defstruct [:list_has?, :list_entries, :mccmnc_of, templates: nil, now: nil, rand: nil]
    @type t :: %__MODULE__{}
  end

  @type state :: %{
          sender: String.t(),
          receiver: String.t(),
          text: String.t(),
          sender_ton: non_neg_integer() | nil,
          sender_npi: non_neg_integer() | nil,
          dest_ton: non_neg_integer() | nil,
          dest_npi: non_neg_integer() | nil,
          billing_type: String.t() | nil,
          registered_delivery: non_neg_integer() | nil,
          dlr_status: String.t() | nil,
          dlr_error: String.t() | nil,
          mccmnc: String.t() | nil
        }

  @type check :: %{condition: String.t(), ok: boolean(), detail: String.t()}
  @type change :: %{field: atom(), before: String.t() | nil, after: String.t() | nil}
  @type step :: %{
          rule_id: integer(),
          name: String.t(),
          matched: boolean(),
          fired: boolean(),
          blocked: boolean(),
          checks: [check()],
          changes: [change()],
          continue_after: boolean()
        }
  @type result :: %{before: state(), after: state(), blocked: boolean(), steps: [step()]}

  @doc """
  The message state before any rule: the message's sender, receiver, text, source TON / NPI and receipt status, and
  the receiver's network.
  """
  @spec initial_state(map(), Context.t()) :: state()
  def initial_state(message, %Context{} = ctx) do
    %{
      sender: Map.get(message, :sender, ""),
      receiver: Map.get(message, :receiver, ""),
      text: Map.get(message, :text, ""),
      sender_ton: Map.get(message, :sender_ton),
      sender_npi: Map.get(message, :sender_npi),
      dest_ton: nil,
      dest_npi: nil,
      billing_type: nil,
      registered_delivery: nil,
      dlr_status: Map.get(message, :dlr_status),
      dlr_error: Map.get(message, :dlr_error),
      mccmnc: ctx.mccmnc_of.(Map.get(message, :receiver, ""))
    }
  end

  @doc """
  Runs `rules` in order on `message`. Each entry is a rule or `{rule, continue_after}`, the trunk's own Continue /
  Stop for the rule (default: the rule's). A block ends the run, and so does a matched rule set to Stop.
  """
  @spec run([Rule.t() | {Rule.t(), boolean() | nil}], map(), Context.t()) :: result()
  def run(rules, message, %Context{} = ctx) do
    before = initial_state(message, ctx)

    {state, steps, blocked} =
      Enum.reduce_while(rules, {before, [], false}, fn entry, {state, steps, _} ->
        {rule, continue_after} = entry(entry)
        {step, state} = run_rule(rule, state, ctx, continue_after)
        steps = [step | steps]

        cond do
          step.blocked -> {:halt, {state, steps, true}}
          step.matched and not step.continue_after -> {:halt, {state, steps, false}}
          true -> {:cont, {state, steps, false}}
        end
      end)

    %{before: before, after: state, blocked: blocked, steps: Enum.reverse(steps)}
  end

  defp entry({%Rule{} = rule, nil}), do: {rule, rule.continue_after}
  defp entry({%Rule{} = rule, continue_after}), do: {rule, continue_after}
  defp entry(%Rule{} = rule), do: {rule, rule.continue_after}

  @doc "Runs one rule on the state; `continue_after` is the trunk's setting (default: the rule's own)."
  @spec run_rule(Rule.t(), state(), Context.t(), boolean() | nil) :: {step(), state()}
  def run_rule(%Rule{} = rule, state, %Context{} = ctx, continue_after \\ nil) do
    checks = checks(rule, state, ctx)
    matched = Enum.all?(checks, & &1.ok)

    step = %{
      rule_id: rule.id,
      name: rule.name,
      matched: matched,
      fired: false,
      blocked: false,
      checks: checks,
      changes: [],
      continue_after: if(is_nil(continue_after), do: rule.continue_after, else: continue_after)
    }

    cond do
      not matched -> {step, state}
      rule.action == :block -> {%{step | blocked: true, fired: true}, state}
      true -> apply_changes(rule, state, ctx, step)
    end
  end

  # ---------------------------------------------------------------- conditions

  @doc "The conditions of one rule on the current state."
  @spec checks(Rule.t(), state(), Context.t()) :: [check()]
  def checks(%Rule{} = rule, s, %Context{} = ctx) do
    sender_case = rule.sender_match_case != false
    c = rule.compiled

    [
      time_check("Start time", rule.starts_at, ctx.now, :future),
      time_check("Stop time", rule.stops_at, ctx.now, :past),
      pattern_check(
        "Sender ID",
        rule.sender_pattern,
        c.sender,
        rule.sender_pattern_negate,
        s.sender,
        sender_case
      ),
      pattern_check(
        "Receiver ID",
        rule.receiver_pattern,
        c.receiver,
        rule.receiver_pattern_negate,
        s.receiver,
        true
      ),
      values_check("Sender ID", rule.sender_values, rule.sender_pattern_negate, s.sender),
      values_check("Receiver ID", rule.receiver_values, rule.receiver_pattern_negate, s.receiver),
      mccmnc_check(rule, s.mccmnc),
      pattern_check(
        "Message Body Text",
        rule.content_pattern,
        c.content,
        rule.content_pattern_negate,
        s.text,
        true
      ),
      list_check(
        "Sender ID List",
        rule.sender_list_id,
        rule.sender_list_negate,
        s.sender,
        ctx,
        sender_case
      ),
      list_check(
        "Receiver ID List",
        rule.receiver_list_id,
        rule.receiver_list_negate,
        s.receiver,
        ctx,
        true
      ),
      length_check("Sender ID length", s.sender, rule.sender_min_length, rule.sender_max_length),
      length_check(
        "Receiver ID length",
        s.receiver,
        rule.receiver_min_length,
        rule.receiver_max_length
      )
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp time_check(_name, nil, _now, _), do: nil

  defp time_check(name, at, now, :future) do
    if DateTime.compare(at, now(now)) == :gt,
      do: %{condition: name, ok: false, detail: "starts #{DateTime.to_iso8601(at)}"}
  end

  defp time_check(name, at, now, :past) do
    if DateTime.compare(at, now(now)) != :gt,
      do: %{condition: name, ok: false, detail: "stopped #{DateTime.to_iso8601(at)}"}
  end

  defp now(nil), do: DateTime.utc_now()
  defp now(now), do: now

  defp pattern_check(_name, nil, _re, _negate, _value, _case), do: nil

  defp pattern_check(name, pattern, :invalid, _negate, _value, _case),
    do: %{condition: name, ok: false, detail: "invalid pattern #{pattern}"}

  defp pattern_check(name, pattern, re, negate, value, match_case) do
    hit = Pattern.match?(re, value)

    %{
      condition: name,
      ok: hit != negate,
      detail:
        "#{Jason.encode!(value)} #{if hit, do: "matches", else: "does not match"} #{if negate, do: "not ", else: ""}" <>
          "#{pattern}#{if match_case, do: "", else: " (any case)"}"
    }
  end

  # Value rows, each with its own match and case (team trial round 8); Not Match as for the pattern.
  defp values_check(_name, [], _negate, _value), do: nil

  defp values_check(name, rows, negate, value) do
    hit = Values.hit?(rows, value)

    %{
      condition: name,
      ok: hit != negate,
      detail:
        "#{Jason.encode!(value)} #{if hit, do: "matches", else: "does not match"} #{Values.text(rows)}" <>
          if(negate, do: " (Not Match)", else: "")
    }
  end

  # Exact codes: a 3-digit code is the "All networks" entry only (team trial round 1); or the MCCMNC regex (team
  # trial round 2). Either one is a hit; Not Match turns it around.
  defp mccmnc_check(%Rule{mccmnc_pattern: nil} = rule, code) do
    if MapSet.size(rule.mccmncs) == 0,
      do: nil,
      else: mccmnc_result(rule, code, code != nil and code in rule.mccmncs)
  end

  defp mccmnc_check(%Rule{compiled: %{mccmnc: :invalid}} = rule, _code),
    do: %{condition: "MCCMNC", ok: false, detail: "invalid pattern #{rule.mccmnc_pattern}"}

  defp mccmnc_check(rule, code) do
    in_list = code != nil and code in rule.mccmncs

    mccmnc_result(
      rule,
      code,
      in_list or (code != nil and Pattern.match?(rule.compiled.mccmnc, code))
    )
  end

  defp mccmnc_result(rule, code, hit) do
    codes = rule.mccmncs |> Enum.sort() |> Enum.take(5)
    more = MapSet.size(rule.mccmncs) - length(codes)

    what =
      [
        if(codes != [],
          do: "in #{Enum.join(codes, ", ")}#{if more > 0, do: " +#{more}", else: ""}"
        ),
        if(rule.mccmnc_pattern, do: "matching #{rule.mccmnc_pattern}")
      ]
      |> Enum.reject(&is_nil/1)
      |> Enum.join(" or ")

    %{
      condition: "MCCMNC",
      ok: hit != rule.mccmnc_negate,
      detail:
        "#{code || "unknown network"} #{if hit, do: "is", else: "is not"} #{what}" <>
          if(rule.mccmnc_negate, do: " (Not Match)", else: "")
    }
  end

  defp list_check(_name, nil, _negate, _value, _ctx, _case), do: nil

  defp list_check(name, id, negate, value, ctx, match_case) do
    hit = ctx.list_has?.(id, value, match_case)

    %{
      condition: name,
      ok: hit != negate,
      detail:
        "#{Jason.encode!(value)} is #{if hit, do: "", else: "not "}in list ##{id}" <>
          "#{if negate, do: " (Not Match)", else: ""}#{if match_case, do: "", else: " (any case)"}"
    }
  end

  defp length_check(_name, _value, min, max) when min <= 0 and max >= 20, do: nil

  defp length_check(name, value, min, max) do
    n = Pattern.js_length(value)
    %{condition: name, ok: n >= min and n <= max, detail: "length #{n}, allowed #{min}-#{max}"}
  end

  @doc """
  Whether a number list entry matches a value: exactly, or, in a Sender ID template entry, each `{n}` standing for one
  digit. `match_case: false` compares any case (team trial round 1).
  """
  @spec entry_matches?(String.t(), String.t(), boolean()) :: boolean()
  def entry_matches?(entry, value, match_case \\ true) do
    if String.contains?(entry, "{n}") do
      source =
        "^" <> (entry |> String.split("{n}") |> Enum.map_join("[0-9]", &Regex.escape/1)) <> "$"

      Pattern.match?(Pattern.compile(source, match_case: match_case), value)
    else
      if match_case, do: entry == value, else: String.downcase(entry) == String.downcase(value)
    end
  end

  # ---------------------------------------------------------------- changes

  defp apply_changes(rule, state, ctx, step) do
    {state, changes} =
      {state, []}
      |> sender_conversion(rule, ctx)
      |> receiver_conversion(rule, ctx)
      |> put_if(:sender_ton, rule.sender_ton)
      |> put_if(:sender_npi, rule.sender_npi)
      |> put_if(:dest_ton, rule.dest_ton)
      |> put_if(:dest_npi, rule.dest_npi)
      |> put_if(:billing_type, rule.billing_type)
      |> put_if(:registered_delivery, rule.registered_delivery)
      |> dlr(rule)
      |> then(fn {s, ch} -> set({s, ch}, :text, rewrite_text(rule, s.text)) end)

    changes = Enum.reverse(changes)
    {%{step | changes: changes, fired: changes != []}, state}
  end

  defp set({state, changes}, field, value) do
    old = Map.fetch!(state, field)

    if value == old,
      do: {state, changes},
      else:
        {Map.put(state, field, value),
         [%{field: field, before: text(old), after: text(value)} | changes]}
  end

  defp text(nil), do: nil
  defp text(v), do: to_string(v)

  defp put_if(acc, _field, nil), do: acc
  defp put_if(acc, field, value), do: set(acc, field, value)

  defp sender_conversion({state, _} = acc, %Rule{sender_conversion: sc} = rule, ctx)
       when sc in [:random_number, :sender_id_template] do
    entries =
      if rule.sender_conversion_list_id,
        do: ctx.list_entries.(rule.sender_conversion_list_id),
        else: []

    if entries == [] do
      acc
    else
      picked = pick(entries, ctx)

      acc = set(acc, :sender, picked_sender(sc, picked, ctx))

      # A Sender ID template with content: our text, with the code taken from the original (team trial round 1).
      contents =
        if sc == :sender_id_template and ctx.templates,
          do: ctx.templates.(rule.sender_conversion_list_id, picked) || [],
          else: []

      if contents == [],
        do: acc,
        else: set(acc, :text, fill_content_template(pick(contents, ctx), state.text))
    end
  end

  defp sender_conversion({state, _} = acc, %Rule{sender_conversion: sc} = rule, _ctx)
       when sc != nil do
    value =
      convert(
        sc,
        rule.sender_conversion_value,
        state.sender,
        rule.sender_conversion_replacement,
        rule.compiled.sender_conversion
      )

    set(acc, :sender, value)
  end

  defp sender_conversion(acc, _rule, _ctx), do: acc

  defp picked_sender(:random_number, picked, _ctx), do: picked

  defp picked_sender(_template, picked, ctx),
    do: Regex.replace(~r/\{n\}/, picked, fn _ -> Integer.to_string(floor(rand(ctx) * 10)) end)

  defp receiver_conversion({state, _} = acc, %Rule{receiver_conversion: rc} = rule, ctx)
       when rc != nil do
    value =
      convert(
        rc,
        rule.receiver_conversion_value,
        state.receiver,
        rule.receiver_conversion_replacement,
        rule.compiled.receiver_conversion
      )

    acc = set(acc, :receiver, value)
    set(acc, :mccmnc, ctx.mccmnc_of.(elem(acc, 0).receiver))
  end

  defp receiver_conversion(acc, _rule, _ctx), do: acc

  defp dlr({state, _} = acc, rule) do
    case map_dlr(rule.dlr_map, state.dlr_status, state.dlr_error) do
      nil -> acc
      %{status: status, error: error} -> acc |> set(:dlr_status, status) |> set(:dlr_error, error)
    end
  end

  defp map_dlr(_map, nil, _error), do: nil

  defp map_dlr(map, status, error) do
    up = String.upcase(status)

    case Enum.find(
           map,
           &(String.upcase(&1.from_status) == up and
               (is_nil(&1.from_error) or &1.from_error == error))
         ) do
      nil -> nil
      hit -> %{status: hit.to_status, error: hit.to_error || error}
    end
  end

  defp pick(list, ctx), do: Enum.at(list, floor(rand(ctx) * length(list)))
  defp rand(%Context{rand: nil}), do: :rand.uniform()
  defp rand(%Context{rand: fun}), do: fun.()

  @doc """
  A Left / Right Strip, Prepend, Append, Translation or Regex Replace. Translation takes only the new value: the
  sender or receiver the conditions matched becomes it (team trial round 1); `"from=to"` swaps a prefix. Regex
  Replace replaces every match of the value (a pattern) with the replacement (`$1`..`$9` are its groups).
  """
  @spec convert(atom(), String.t() | nil, String.t(), String.t() | nil, Pattern.t() | nil | false) ::
          String.t()
  def convert(kind, value, input, replacement \\ nil, compiled \\ nil) do
    v = value || ""

    case kind do
      :left_strip ->
        left_strip(v, input)

      :right_strip ->
        right_strip(v, input)

      :prepend ->
        v <> input

      :append ->
        input <> v

      :translation ->
        translation(v, input)

      :regex_replace ->
        regex_replace(v, input, replacement, compiled)

      _ ->
        input
    end
  end

  defp left_strip(v, input) do
    drop = v |> number() |> trunc() |> max(0)
    input |> String.to_charlist() |> Enum.drop(drop) |> List.to_string()
  end

  defp right_strip(v, input) do
    chars = String.to_charlist(input)
    keep = max(0, length(chars) - number(v)) |> trunc()
    chars |> Enum.take(keep) |> List.to_string()
  end

  defp regex_replace(v, input, replacement, compiled),
    do: Pattern.replace_js(compiled || Pattern.compile(v), input, replacement || "")

  # JavaScript's Number(v) || 0 for a strip count: a number, else 0.
  defp number(v) do
    case Float.parse(String.trim(v)) do
      {n, ""} -> n
      _ -> 0
    end
  end

  defp translation(v, input) do
    case :binary.split(v, "=") do
      [_no_equals] ->
        if v == "", do: input, else: v

      [from, to] ->
        if String.starts_with?(input, from),
          do: to <> binary_part(input, byte_size(from), byte_size(input) - byte_size(from)),
          else: input
    end
  end

  @doc "The code in a message (the first run of 4–8 digits), as `{code}` in a Sender ID template's content."
  @spec code_in(String.t()) :: String.t()
  def code_in(text) do
    case Regex.run(~r/(?<!\d)\d{4,8}(?!\d)/, text) do
      [code] when is_binary(code) -> code
      nil -> ""
    end
  end

  @doc "A Sender ID template's content: `{code}` = the code in the original text, `{text}` = the original text."
  @spec fill_content_template(String.t(), String.t()) :: String.t()
  def fill_content_template(template, original) do
    template |> String.replace("{code}", code_in(original)) |> String.replace("{text}", original)
  end

  @doc """
  Words or phrases replaced as typed (no regex): whole words and exact case by default; removing a word also tidies
  the space it leaves (team trial round 1).
  """
  @spec replace_words(String.t(), [map()]) :: String.t()
  def replace_words(text, words) do
    Enum.reduce(words, text, fn
      {nil, _w}, out ->
        out

      {re, w}, out ->
        out = Pattern.replace(re, out, fn _match, _groups, _before, _after -> w.replace end)
        if w.replace == "", do: tidy(out), else: out
    end)
  end

  defp tidy(text) do
    text
    |> String.replace(~r/[ \t]{2,}/, " ")
    |> String.replace(~r/ +([,.!?;:])/, "\\1")
    |> String.trim()
  end

  @doc """
  One number through a digit pattern (team trial round 6): `#` takes the next digit, anything else is kept as typed.
  A longer number repeats the pattern's last group with the separator before it; a shorter one stops after its last
  digit. What follows the last `#` (e.g. a closing bracket) is added when the pattern was filled to the end. Same as
  formatNumber in mock/src/routing/translate.ts.
  """
  @spec format_number(String.t(), String.t()) :: String.t()
  def format_number(digits, pattern) do
    chars = String.graphemes(pattern)

    case Enum.find_index(Enum.reverse(chars), &(&1 == "#")) do
      nil ->
        digits

      rev ->
        last = length(chars) - 1 - rev
        group_start = back_while(chars, last, &(&1 == "#"))
        sep_start = back_while(chars, group_start, &(&1 != "#"))
        head = Enum.slice(chars, 0..last)
        repeat = Enum.slice(chars, sep_start..last)
        tail = chars |> Enum.drop(last + 1) |> Enum.join()
        {out, filled} = fill(head, repeat, String.graphemes(digits), [])
        if filled, do: out <> tail, else: out
    end
  end

  # The index where a run of characters matching `pred` ends, walking left from `i` (exclusive).
  defp back_while(chars, i, pred) do
    if i > 0 and pred.(Enum.at(chars, i - 1)), do: back_while(chars, i - 1, pred), else: i
  end

  # Walks the pattern part by part (the head, then the repeated last group), consuming digits; says whether the last
  # part was filled to its end, so the tail is added.
  defp fill(_part, _repeat, [], acc), do: {acc |> Enum.reverse() |> Enum.join(), false}

  defp fill(part, repeat, digits, acc) do
    {acc, rest, complete} =
      Enum.reduce_while(part, {acc, digits, true}, fn
        _ch, {acc, [], _} -> {:halt, {acc, [], false}}
        "#", {acc, [d | ds], _} -> {:cont, {[d | acc], ds, true}}
        ch, {acc, ds, _} -> {:cont, {[ch | acc], ds, true}}
      end)

    if rest == [],
      do: {acc |> Enum.reverse() |> Enum.join(), complete and List.last(part) == "#"},
      else: fill(repeat, repeat, rest, acc)
  end

  @doc "Every run of at least `min_digits` (nil = 6) digits in the text, through the number format (nil = off)."
  @spec format_numbers(String.t(), String.t() | nil, integer() | nil) :: String.t()
  def format_numbers(text, nil, _min), do: text

  def format_numbers(text, pattern, min) do
    if String.contains?(pattern, "#"),
      do: Regex.replace(~r/\d+/, text, &format_run(&1, pattern, max(2, min || 6))),
      else: text
  end

  defp format_run(run, pattern, min) when byte_size(run) >= min, do: format_number(run, pattern)
  defp format_run(run, _pattern, _min), do: run

  @doc "Content rewrite: words, the number format, then the Regex Index group (or the whole match), then the MSG Template."
  @spec rewrite_text(Rule.t(), String.t()) :: String.t()
  def rewrite_text(%Rule{} = rule, text) do
    out =
      text
      |> replace_words(rule.compiled.words)
      |> format_numbers(rule.content_number_format, rule.content_number_min_digits)

    out =
      if rule.content_regex && rule.content_replacement != nil,
        do: rewrite_regex(rule, out),
        else: out

    if rule.msg_template, do: String.replace(rule.msg_template, "{text}", out), else: out
  end

  # Message Text can reuse what the pattern caught (team trial round 2): $1..$9 are its groups, $0 the whole match.
  defp rewrite_regex(rule, text) do
    Pattern.replace(rule.compiled.content_regex, text, fn match, groups, _before, _after ->
      new =
        Regex.replace(~r/\$([0-9])/, rule.content_replacement, fn _, d ->
          group_text(d, match, groups)
        end)

      case rule.content_regex_index do
        idx when idx in [nil, 0] -> new
        idx -> replace_group(match, Enum.at(groups, idx - 1), new)
      end
    end)
  end

  defp group_text("0", match, _groups), do: match
  defp group_text(d, _match, groups), do: Enum.at(groups, String.to_integer(d) - 1) || ""

  # Only the group's text is replaced inside the match; a group that did not take part leaves the match as is.
  defp replace_group(match, nil, _new), do: match
  # JavaScript's indexOf("") is 0: an empty group puts the new text first.
  defp replace_group(match, "", new), do: new <> match

  defp replace_group(match, group, new) do
    case :binary.match(match, group) do
      {at, len} ->
        binary_part(match, 0, at) <>
          new <> binary_part(match, at + len, byte_size(match) - at - len)

      :nomatch ->
        match
    end
  end
end
