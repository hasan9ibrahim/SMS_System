defmodule Sms.Switch.Voice.Ami do
  @moduledoc """
  The Asterisk Manager Interface wire format (§8 SMS to voice, docs/SMS_TO_VOICE.md): what `Sms.Switch.Voice.AmiClient`
  sends and reads. Pure.

  A message is `Key: Value` lines ending in CRLF, closed by an empty line. Asterisk greets a new connection with one
  line (`Asterisk Call Manager/<version>`). Keys are read in lower case; a key given twice (a command's `Output`) is
  kept as its lines joined with newlines.
  """

  @typedoc "A message read from Asterisk: lower-case keys."
  @type frame :: %{optional(String.t()) => String.t()}

  @doc """
  An action as sent: the fields in order, each value on one line (carriage returns and newlines are dropped, so a value
  can never start another field or action).
  """
  @spec encode([{String.t(), String.t() | integer()}]) :: iolist()
  def encode(fields) do
    [Enum.map(fields, fn {key, value} -> [key, ": ", one_line(value), "\r\n"] end), "\r\n"]
  end

  defp one_line(value) when is_integer(value), do: Integer.to_string(value)
  defp one_line(value), do: String.replace(value, ["\r", "\n"], "")

  @doc "The greeting line, once it has fully arrived: `{:ok, line, rest}`, or `:more`."
  @spec banner(binary()) :: {:ok, String.t(), binary()} | :more
  def banner(buffer) do
    case :binary.split(buffer, "\r\n") do
      [line, rest] -> {:ok, line, rest}
      [_] -> :more
    end
  end

  @doc "The complete messages in `buffer`, and what is left of the next one."
  @spec decode(binary()) :: {[frame()], binary()}
  def decode(buffer), do: decode(buffer, [])

  defp decode(buffer, frames) do
    case :binary.split(buffer, "\r\n\r\n") do
      [frame, rest] -> decode(rest, [parse(frame) | frames])
      [rest] -> {Enum.reverse(frames), rest}
    end
  end

  defp parse(frame) do
    frame
    |> String.split("\r\n")
    |> Enum.reduce(%{}, &field(:binary.split(&1, ": "), &2))
  end

  defp field([key, value], acc),
    do: Map.update(acc, String.downcase(key), value, &(&1 <> "\n" <> value))

  # A field with an empty value ("Key:"); other lines (a command's raw output) carry no field.
  defp field([key], acc) do
    if String.ends_with?(key, ":"),
      do: Map.put_new(acc, key |> String.trim_trailing(":") |> String.downcase(), ""),
      else: acc
  end

  @doc """
  The cause of a call that was not answered, from `OriginateResponse`'s `Reason` (Asterisk's control frame: 0 the call
  could not be made, 1 hung up or rejected before answer, 3 rang until the timeout, 5 busy, 8 congestion).
  """
  @spec reason_cause(String.t() | nil) :: String.t()
  def reason_cause("0"), do: "FAILURE"
  def reason_cause("1"), do: "CALL_REJECTED"
  def reason_cause("3"), do: "NO_ANSWER"
  def reason_cause("5"), do: "USER_BUSY"
  def reason_cause("8"), do: "CONGESTION"
  def reason_cause(_reason), do: "UNKNOWN"

  # Q.850 causes as Asterisk names them (`ast_cause2str`), for the ones a call to a voice switch ends with.
  @causes %{
    "1" => "UNALLOCATED",
    "3" => "NO_ROUTE_DESTINATION",
    "16" => "NORMAL_CLEARING",
    "17" => "USER_BUSY",
    "18" => "NO_USER_RESPONSE",
    "19" => "NO_ANSWER",
    "21" => "CALL_REJECTED",
    "27" => "DESTINATION_OUT_OF_ORDER",
    "28" => "INVALID_NUMBER_FORMAT",
    "31" => "NORMAL_UNSPECIFIED",
    "34" => "NORMAL_CIRCUIT_CONGESTION",
    "38" => "NETWORK_OUT_OF_ORDER",
    "41" => "NORMAL_TEMPORARY_FAILURE",
    "102" => "RECOVERY_ON_TIMER_EXPIRE"
  }

  @doc """
  The cause of a call's end, from a `Hangup` event's `Cause` (e.g. `16` → `NORMAL_CLEARING`); an unknown code by its
  `Cause-txt` in upper case with underscores, else `UNKNOWN`.
  """
  @spec hangup_cause(frame()) :: String.t()
  def hangup_cause(frame) do
    case Map.fetch(@causes, frame["cause"] || "") do
      {:ok, name} ->
        name

      :error ->
        case String.trim(frame["cause-txt"] || "") do
          "" -> "UNKNOWN"
          text -> text |> String.upcase() |> String.replace(~r/[^A-Z0-9]+/, "_")
        end
    end
  end
end
