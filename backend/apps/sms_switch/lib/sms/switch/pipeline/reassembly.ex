defmodule Sms.Switch.Pipeline.Reassembly do
  @moduledoc """
  Customer multipart messages (docs/SMPP_SCENARIOS.md S-3.2–S-3.7, D1). Each part gets its own `submit_sm_resp` and
  message id at once and is held in its group (key: trunk + source + destination + reference + total parts, never the
  session, S-3.3) in `Sms.Switch.Pipeline.Store`. When the last part comes the message is put together and goes through
  translation, rating and routing once, on the full text (S-3.2, S-4.3); the vendor gets it split again in its own
  format (`Sms.Switch.Pipeline.Sender`).

    * the same part again gets the message id it got the first time and is not held twice (S-3.5);
    * a group still incomplete after the customer trunk's reassembly timeout (default 120 s) fails: every part held
      gets a REJECTD receipt (if asked for) with error 099, an EDR row, and is not billed (D1); a part that comes
      after its group closed starts a new group (S-3.7);
    * a message refused once put together (no rate, no route, a translation block) is answered the same way, with the
      refusal's status as the error: its parts were already accepted.

  A part accepted over the trunk's TPS holds an overflow buffer place while it waits (S-2.4); when the group ends,
  the parts give their places back, all but the one the message keeps while it waits in the trunk's buffer.

  The parts wait in Redis, not on the durable bus, for at most the reassembly timeout: Redis runs with append-only
  persistence and a replica (docs/BACKEND_PLAN.md).
  """
  require Logger
  alias Sms.Switch.Message.Concat
  alias Sms.Switch.Pipeline.{Edr, Forwarder, Intake, Store}
  alias Sms.Switch.Smpp.Status

  @incomplete_error "099"
  @default_timeout_s 120
  @batch 200

  @doc "Holds one part; the intake's reply for it."
  @spec hold(map()) :: {:ok, map(), list()} | {:error, atom()}
  def hold(part) do
    key = key(part)
    n = part.concat.seq
    timeout_s = part.trunk[:reassembly_timeout_s] || @default_timeout_s
    deadline = part.received_at + timeout_s * 1_000

    case Store.add_part(key, n, part.id, part, timeout_s + 600, deadline) do
      {:ok, count} when count >= part.concat.total -> complete(key, part)
      {:ok, _count} -> {:ok, %{message_id: part.id}, []}
      {:duplicate, id} -> duplicate(part, id)
      {:error, reason} -> store_error(part, reason)
    end
  end

  defp duplicate(part, id) do
    Intake.leave_buffer(part)
    {:ok, %{message_id: id}, []}
  end

  defp key(part) do
    f = part.fields
    c = part.concat
    "#{part.trunk.id}:#{f[:source_addr]}:#{f[:destination_addr]}:#{c.ref}:#{c.total}"
  end

  defp store_error(part, reason) do
    Logger.error("part of #{part.id} not held, answered 0x08: #{inspect(reason)}")
    Intake.leave_buffer(part)
    {:error, :esme_rsyserr}
  end

  # The last part: put the message together and send it on; this part's resp waits until it is stored (S-2.2).
  defp complete(key, last) do
    if Store.claim_group(key) do
      case Store.group_parts(key) do
        {:ok, parts} -> process(key, last, parts)
        {:error, reason} -> give_back(key, last, reason)
      end
    else
      {:ok, %{message_id: last.id}, []}
    end
  end

  defp process(key, last, parts) do
    msg = assemble(parts)

    case Intake.process(msg) do
      :ok ->
        # The message waits in the trunk's buffer on one place, if any part had one (S-2.4).
        leave_buffer(Map.values(parts), if(msg.buffered, do: 1, else: 0))
        _ = Store.drop_group(key)
        {:ok, %{message_id: last.id}, []}

      {:reject, status, reason, _refused} ->
        code = Status.code(status)

        Logger.info(
          "multipart message refused once put together (#{inspect(reason)}): 0x#{Integer.to_string(code, 16)}"
        )

        fail(Map.values(parts), code, error(code))
        _ = Store.drop_group(key)
        {:ok, %{message_id: last.id}, []}

      {:error, reason} ->
        give_back(key, last, reason)
    end
  end

  # Not stored: this part is given back and answered 0x14, so the client sends it again and completes the group.
  defp give_back(key, last, reason) do
    Logger.error("message of #{last.id} not stored, part answered 0x14: #{inspect(reason)}")
    _ = Store.drop_part(key, last.concat.seq)
    _ = Store.unclaim_group(key)
    Intake.leave_buffer(last)
    {:error, :esme_rmsgqful}
  end

  # The overflow buffer places the group's parts held, but `kept` (S-2.4).
  defp leave_buffer([], _kept), do: :ok

  defp leave_buffer([part | _] = parts, kept) do
    held = Enum.count(parts, & &1.buffered)
    Intake.leave_buffer(%{part | buffered: true}, held - kept)
  end

  @doc false
  # One message from its parts, in part order: the first part's fields, every part's text and message id.
  @spec assemble(%{pos_integer() => map()}) :: map()
  def assemble(parts) do
    ordered = parts |> Enum.sort_by(&elem(&1, 0)) |> Enum.map(&elem(&1, 1))
    first = hd(ordered)
    texts = Enum.map(ordered, & &1.text)

    %{
      first
      | body: Enum.map_join(ordered, & &1.body),
        text: if(Enum.all?(texts, &is_binary/1), do: Enum.join(texts), else: nil),
        # The parts' other UDH elements (ports, a language shift table) go on with the message (D9, S-3.12).
        udh: Concat.udh(Concat.other_elements(first.udh)),
        concat: nil,
        parts: length(ordered),
        buffered: Enum.any?(ordered, & &1.buffered)
    }
    |> Map.put(:ids, Enum.map(ordered, & &1.id))
    |> Map.put(:reassembled, true)
  end

  @doc """
  Fails the groups whose reassembly timeout passed (D1); run by `Sms.Switch.Pipeline.Timeouts`.
  """
  @spec sweep() :: :ok
  def sweep do
    case Store.due_groups(System.os_time(:millisecond), @batch) do
      {:ok, keys} ->
        Enum.each(keys, &time_out/1)
        if length(keys) == @batch, do: sweep(), else: :ok

      {:error, reason} ->
        Logger.warning("multipart groups not swept: #{inspect(reason)}")
    end
  end

  defp time_out(key) do
    with true <- Store.claim_group_timeout(key),
         true <- Store.claim_group(key),
         {:ok, parts} <- Store.group_parts(key) do
      parts = Map.values(parts)

      Logger.info(
        "multipart message incomplete after its timeout: #{length(parts)} parts refused (D1)"
      )

      fail(parts, Status.code(:esme_rsubmitfail), @incomplete_error)
      _ = Store.drop_group(key)
      :ok
    end
  end

  # Each part held: an EDR row (refused, not billed) and a REJECTD receipt if the customer asked for one; its overflow
  # buffer place back.
  defp fail(parts, command_status, error) do
    leave_buffer(parts, 0)

    Enum.each(parts, fn part ->
      edr_id = Edr.new_id()

      row =
        Edr.attempt_row(part, %{
          edr_id: edr_id,
          no: 0,
          final: true,
          success: false,
          vendor: nil,
          command_status: command_status,
          msg_count: 1
        })

      _ = Edr.publish_attempt(row)
      Forwarder.switch_receipt(part, edr_id, "REJECTD", error)
    end)
  end

  # The receipt error of a refusal: its status's last three hex digits (as for a vendor's refusal).
  defp error(code),
    do: code |> Integer.to_string(16) |> String.pad_leading(3, "0") |> String.slice(-3, 3)
end
