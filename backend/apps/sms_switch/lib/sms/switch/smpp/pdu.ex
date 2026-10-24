defmodule Sms.Switch.Smpp.Pdu do
  @moduledoc """
  SMPP 3.4 PDUs (spec §4): decoding from a byte stream and encoding back, for every 3.4 command.

  ## Decoding

  `decode/2` takes whatever bytes a socket delivered and frames strictly by `command_length`
  (docs/SMPP_SCENARIOS.md S-1.8): it returns one PDU and the bytes after it, `{:incomplete, n}` while fewer bytes
  than the frame has arrived, or an error. Errors never raise and carry what the session needs to answer:

    * a bad `command_length` (below 16 or above `:max_length`, S-1.9) is **fatal**: the stream cannot be framed any
      more, so answer `generic_nack` 0x02 and close;
    * anything else wrong inside a well-framed PDU (unknown command id S-1.10, a field too long, a broken TLV stream)
      skips just that frame: answer it with `error_reply/1` (a response with the precise status, or
      `generic_nack`) and carry on with `rest`.

  ## Encoding

  `encode/1` checks every field against the spec (C-string lengths, integer ranges, `short_message` at most 254
  octets) and fills in `command_length` and `sm_length`. An unknown field name is an error, so a typo never sends
  a silently empty field.

  ## Fields

  `fields` is a map with the spec's field names as atoms (`:source_addr`, `:short_message`, …); `tlvs` is a list of
  `{name, value}` (see `Sms.Switch.Smpp.Tlv`). On decode every mandatory field is present. A response whose body is
  empty (allowed when `command_status` is not 0, and sent by some SMSCs even with 0) decodes with empty `fields`.
  """
  alias Sms.Switch.Smpp.{Command, Status, Tlv}

  @header_size 16
  # S-1.9: 64 KB of message_payload plus the header and mandatory fields of the largest PDU.
  @default_max_length 66_000

  defstruct command: nil, status: 0, sequence: 0, fields: %{}, tlvs: []

  @type t :: %__MODULE__{
          command: Command.t(),
          status: non_neg_integer(),
          sequence: non_neg_integer(),
          fields: map(),
          tlvs: [Tlv.t()]
        }

  defmodule Error do
    @moduledoc """
    A PDU that could not be decoded. `status` is the SMPP status to answer with; `fatal` means the byte stream can no
    longer be framed and the session must close after answering.
    """
    defexception [:status, :command, :command_id, :sequence, :reason, fatal: false]

    @type t :: %__MODULE__{
            status: atom(),
            command: Sms.Switch.Smpp.Command.t() | nil,
            command_id: non_neg_integer() | nil,
            sequence: non_neg_integer() | nil,
            reason: term(),
            fatal: boolean()
          }

    @impl true
    def message(e),
      do:
        "#{e.status} on #{e.command || inspect(e.command_id)} (sequence #{inspect(e.sequence)}): #{inspect(e.reason)}"
  end

  # ---------------------------------------------------------------- layouts (spec §4)

  @bind [
    system_id: {:cstring, 16, :esme_rinvsysid},
    password: {:cstring, 9, :esme_rinvpaswd},
    system_type: {:cstring, 13, :esme_rinvsystyp},
    interface_version: :int8,
    addr_ton: :int8,
    addr_npi: :int8,
    address_range: {:cstring, 41, :esme_rinvparlen}
  ]
  @bind_resp [system_id: {:cstring, 16, :esme_rinvsysid}]
  @message_id_resp [message_id: {:cstring, 65, :esme_rinvmsgid}]
  @short_message_tail [
    esm_class: :int8,
    protocol_id: :int8,
    priority_flag: :int8,
    schedule_delivery_time: {:time, :esme_rinvsched},
    validity_period: {:time, :esme_rinvexpiry},
    registered_delivery: :int8,
    replace_if_present_flag: :int8,
    data_coding: :int8,
    sm_default_msg_id: :int8,
    short_message: :short_message
  ]
  @sm [
        service_type: {:cstring, 6, :esme_rinvsertyp},
        source_addr_ton: :int8,
        source_addr_npi: :int8,
        source_addr: {:cstring, 21, :esme_rinvsrcadr},
        dest_addr_ton: :int8,
        dest_addr_npi: :int8,
        destination_addr: {:cstring, 21, :esme_rinvdstadr}
      ] ++ @short_message_tail

  @layouts %{
    generic_nack: [],
    bind_receiver: @bind,
    bind_receiver_resp: @bind_resp,
    bind_transmitter: @bind,
    bind_transmitter_resp: @bind_resp,
    bind_transceiver: @bind,
    bind_transceiver_resp: @bind_resp,
    outbind: [
      system_id: {:cstring, 16, :esme_rinvsysid},
      password: {:cstring, 9, :esme_rinvpaswd}
    ],
    unbind: [],
    unbind_resp: [],
    enquire_link: [],
    enquire_link_resp: [],
    submit_sm: @sm,
    submit_sm_resp: @message_id_resp,
    deliver_sm: @sm,
    deliver_sm_resp: @message_id_resp,
    data_sm: [
      service_type: {:cstring, 6, :esme_rinvsertyp},
      source_addr_ton: :int8,
      source_addr_npi: :int8,
      source_addr: {:cstring, 65, :esme_rinvsrcadr},
      dest_addr_ton: :int8,
      dest_addr_npi: :int8,
      destination_addr: {:cstring, 65, :esme_rinvdstadr},
      esm_class: :int8,
      registered_delivery: :int8,
      data_coding: :int8
    ],
    data_sm_resp: @message_id_resp,
    query_sm: [
      message_id: {:cstring, 65, :esme_rinvmsgid},
      source_addr_ton: :int8,
      source_addr_npi: :int8,
      source_addr: {:cstring, 21, :esme_rinvsrcadr}
    ],
    query_sm_resp: [
      message_id: {:cstring, 65, :esme_rinvmsgid},
      final_date: {:time, :esme_rinvparlen},
      message_state: :int8,
      error_code: :int8
    ],
    cancel_sm: [
      service_type: {:cstring, 6, :esme_rinvsertyp},
      message_id: {:cstring, 65, :esme_rinvmsgid},
      source_addr_ton: :int8,
      source_addr_npi: :int8,
      source_addr: {:cstring, 21, :esme_rinvsrcadr},
      dest_addr_ton: :int8,
      dest_addr_npi: :int8,
      destination_addr: {:cstring, 21, :esme_rinvdstadr}
    ],
    cancel_sm_resp: [],
    replace_sm: [
      message_id: {:cstring, 65, :esme_rinvmsgid},
      source_addr_ton: :int8,
      source_addr_npi: :int8,
      source_addr: {:cstring, 21, :esme_rinvsrcadr},
      schedule_delivery_time: {:time, :esme_rinvsched},
      validity_period: {:time, :esme_rinvexpiry},
      registered_delivery: :int8,
      sm_default_msg_id: :int8,
      short_message: :short_message
    ],
    replace_sm_resp: [],
    submit_multi:
      [
        service_type: {:cstring, 6, :esme_rinvsertyp},
        source_addr_ton: :int8,
        source_addr_npi: :int8,
        source_addr: {:cstring, 21, :esme_rinvsrcadr},
        dest_addresses: :dest_addresses
      ] ++ @short_message_tail,
    submit_multi_resp: [
      message_id: {:cstring, 65, :esme_rinvmsgid},
      unsuccess_smes: :unsuccess_smes
    ],
    alert_notification: [
      source_addr_ton: :int8,
      source_addr_npi: :int8,
      source_addr: {:cstring, 65, :esme_rinvsrcadr},
      esme_addr_ton: :int8,
      esme_addr_npi: :int8,
      esme_addr: {:cstring, 65, :esme_rinvsrcadr}
    ]
  }

  # Responses that carry no body when command_status is not 0 (spec §4.4.2, §4.6.2, §4.7.2).
  @no_body_on_error [:submit_sm_resp, :deliver_sm_resp, :data_sm_resp]

  @time_format ~r/\A\d{12}\d\d{2}[+\-R]\z/

  @doc "The mandatory fields of a command, in wire order, as `{name, type}`."
  @spec layout(Command.t()) :: keyword()
  def layout(command), do: Map.fetch!(@layouts, command)

  # ---------------------------------------------------------------- building

  @doc "A new PDU. `fields` may leave out fields; they encode as empty strings, 0 or empty lists."
  @spec new(Command.t(), map(), keyword()) :: t()
  def new(command, fields \\ %{}, opts \\ []) do
    %__MODULE__{
      command: command,
      fields: fields,
      sequence: Keyword.get(opts, :sequence, 0),
      status: Status.code(Keyword.get(opts, :status, 0)),
      tlvs: Keyword.get(opts, :tlvs, [])
    }
  end

  @doc "The response to a request: same sequence number, the given status and fields."
  @spec response(t(), Status.name() | non_neg_integer(), map(), [Tlv.t()]) :: t()
  def response(
        %__MODULE__{command: command, sequence: seq},
        status \\ :esme_rok,
        fields \\ %{},
        tlvs \\ []
      ) do
    case Command.response(command) do
      nil -> raise ArgumentError, "#{command} has no response"
      resp -> new(resp, fields, sequence: seq, status: status, tlvs: tlvs)
    end
  end

  @doc "A generic_nack with the given status, for a PDU that cannot be answered with its own response."
  @spec generic_nack(non_neg_integer(), Status.name() | non_neg_integer()) :: t()
  def generic_nack(sequence, status),
    do: new(:generic_nack, %{}, sequence: sequence, status: status)

  @doc """
  What to send back for a PDU that failed to decode: its own response with the error status when it was a request
  with a response, a `generic_nack` otherwise, and nothing for a broken response (it is logged, never answered).
  """
  @spec error_reply(Error.t()) :: t() | nil
  def error_reply(%Error{command: nil, sequence: seq, status: status}),
    do: generic_nack(seq || 0, status)

  def error_reply(%Error{command: command, sequence: seq, status: status} = error) do
    cond do
      error.fatal -> generic_nack(seq || 0, status)
      Command.response?(command) -> nil
      resp = Command.response(command) -> new(resp, %{}, sequence: seq, status: status)
      true -> generic_nack(seq, status)
    end
  end

  # ---------------------------------------------------------------- decoding

  @doc """
  Decodes the first PDU in `buffer`. Options: `:max_length` (default #{@default_max_length} octets).
  """
  @spec decode(binary(), keyword()) ::
          {:ok, t(), binary()} | {:incomplete, pos_integer()} | {:error, Error.t(), binary()}
  def decode(buffer, opts \\ [])

  def decode(buffer, _opts) when byte_size(buffer) < 4, do: {:incomplete, 4 - byte_size(buffer)}

  def decode(<<length::32, _::binary>> = buffer, opts) do
    max = Keyword.get(opts, :max_length, @default_max_length)

    cond do
      length < @header_size or length > max ->
        {:error, fatal_length_error(buffer, length), <<>>}

      byte_size(buffer) < length ->
        {:incomplete, length - byte_size(buffer)}

      true ->
        <<frame::binary-size(length), rest::binary>> = buffer
        {decode_frame(frame), rest} |> tag_rest()
    end
  end

  defp tag_rest({{:ok, pdu}, rest}), do: {:ok, pdu, rest}
  defp tag_rest({{:error, error}, rest}), do: {:error, error, rest}

  defp fatal_length_error(buffer, length) do
    {id, seq} =
      case buffer do
        <<_::32, id::32, _::32, seq::32, _::binary>> -> {id, seq}
        _ -> {nil, nil}
      end

    %Error{
      status: :esme_rinvcmdlen,
      command_id: id,
      command: id && command_name(id),
      sequence: seq,
      reason: {:command_length, length},
      fatal: true
    }
  end

  defp command_name(id) do
    case Command.name(id) do
      {:ok, name} -> name
      :error -> nil
    end
  end

  defp decode_frame(<<_len::32, id::32, status::32, seq::32, body::binary>>) do
    case Command.name(id) do
      :error ->
        {:error,
         %Error{
           status: :esme_rinvcmdid,
           command_id: id,
           sequence: seq,
           reason: :unknown_command_id
         }}

      {:ok, command} ->
        error = %Error{command: command, command_id: id, sequence: seq}

        with {:ok, fields, tlv_bytes} <- decode_body(command, body),
             {:ok, tlvs} <- Tlv.decode(tlv_bytes) do
          {:ok,
           %__MODULE__{
             command: command,
             status: status,
             sequence: seq,
             fields: fields,
             tlvs: tlvs
           }}
        else
          {:error, smpp_status, reason} ->
            {:error, %{error | status: smpp_status, reason: reason}}
        end
    end
  end

  defp decode_body(command, <<>>) do
    if Command.response?(command),
      do: {:ok, %{}, <<>>},
      else: decode_fields(layout(command), <<>>, %{})
  end

  defp decode_body(command, body), do: decode_fields(layout(command), body, %{})

  defp decode_fields([], rest, acc), do: {:ok, acc, rest}

  defp decode_fields([{name, type} | layout], bin, acc) do
    case decode_field(type, bin) do
      {:ok, value, rest} -> decode_fields(layout, rest, Map.put(acc, name, value))
      {:error, status, reason} -> {:error, status, {name, reason}}
    end
  end

  defp decode_field(:int8, <<v::8, rest::binary>>), do: {:ok, v, rest}
  defp decode_field(:int8, <<>>), do: {:error, :esme_rinvcmdlen, :missing}

  defp decode_field({:cstring, max, status}, bin), do: cstring(bin, max, status)

  defp decode_field({:time, status}, bin) do
    with {:ok, value, rest} <- cstring(bin, 17, status) do
      if value == "" or Regex.match?(@time_format, value),
        do: {:ok, value, rest},
        else: {:error, status, {:invalid_time, value}}
    end
  end

  defp decode_field(:short_message, <<len::8, rest::binary>>)
       when len <= 254 and byte_size(rest) >= len do
    <<sm::binary-size(len), rest::binary>> = rest
    {:ok, sm, rest}
  end

  defp decode_field(:short_message, <<len::8, _::binary>>),
    do: {:error, :esme_rinvmsglen, {:sm_length, len}}

  defp decode_field(:short_message, <<>>), do: {:error, :esme_rinvcmdlen, :missing}

  defp decode_field(:dest_addresses, <<n::8, rest::binary>>) when n in 1..254,
    do: dest_addresses(n, rest, [])

  defp decode_field(:dest_addresses, <<n::8, _::binary>>),
    do: {:error, :esme_rinvnumdests, {:number_of_dests, n}}

  defp decode_field(:dest_addresses, <<>>), do: {:error, :esme_rinvcmdlen, :missing}

  defp decode_field(:unsuccess_smes, <<n::8, rest::binary>>), do: unsuccess_smes(n, rest, [])
  defp decode_field(:unsuccess_smes, <<>>), do: {:error, :esme_rinvcmdlen, :missing}

  defp cstring(bin, max, status) do
    case :binary.match(bin, <<0>>, scope: {0, min(max, byte_size(bin))}) do
      {pos, 1} ->
        <<value::binary-size(pos), 0, rest::binary>> = bin
        {:ok, value, rest}

      :nomatch when byte_size(bin) < max ->
        {:error, :esme_rinvcmdlen, :unterminated}

      :nomatch ->
        {:error, status, {:longer_than, max - 1}}
    end
  end

  defp dest_addresses(0, rest, acc), do: {:ok, Enum.reverse(acc), rest}

  defp dest_addresses(n, <<1, ton::8, npi::8, rest::binary>>, acc) do
    with {:ok, addr, rest} <- cstring(rest, 21, :esme_rinvdstadr) do
      dest_addresses(n - 1, rest, [%{dest_flag: 1, ton: ton, npi: npi, address: addr} | acc])
    end
  end

  defp dest_addresses(n, <<2, rest::binary>>, acc) do
    with {:ok, name, rest} <- cstring(rest, 21, :esme_rinvdlname) do
      dest_addresses(n - 1, rest, [%{dest_flag: 2, dl_name: name} | acc])
    end
  end

  defp dest_addresses(_n, <<flag::8, _::binary>>, _acc) when flag not in [1, 2],
    do: {:error, :esme_rinvdestflag, {:dest_flag, flag}}

  defp dest_addresses(_n, _bin, _acc), do: {:error, :esme_rinvcmdlen, :truncated_dest_address}

  defp unsuccess_smes(0, rest, acc), do: {:ok, Enum.reverse(acc), rest}

  defp unsuccess_smes(n, <<ton::8, npi::8, rest::binary>>, acc) do
    with {:ok, addr, rest} <- cstring(rest, 21, :esme_rinvdstadr) do
      case rest do
        <<code::32, rest::binary>> ->
          unsuccess_smes(n - 1, rest, [
            %{ton: ton, npi: npi, address: addr, error_status_code: code} | acc
          ])

        _ ->
          {:error, :esme_rinvcmdlen, :truncated_unsuccess_sme}
      end
    end
  end

  defp unsuccess_smes(_n, _bin, _acc), do: {:error, :esme_rinvcmdlen, :truncated_unsuccess_sme}

  # ---------------------------------------------------------------- encoding

  @doc "Encodes a PDU to the bytes to write on the socket."
  @spec encode(t()) :: {:ok, binary()} | {:error, term()}
  def encode(%__MODULE__{command: command} = pdu) do
    with {:ok, layout} <- fetch_layout(command),
         :ok <- check_header(pdu),
         :ok <- check_keys(pdu.fields, layout),
         :ok <- check_payload(pdu),
         {:ok, body} <- encode_body(pdu, layout),
         {:ok, tlvs} <- Tlv.encode(pdu.tlvs) do
      body = IO.iodata_to_binary([body, tlvs])
      length = @header_size + byte_size(body)

      {:ok,
       <<length::32, Command.id(command)::32, Status.code(pdu.status)::32, pdu.sequence::32,
         body::binary>>}
    end
  end

  @doc "Like `encode/1`, raising on an invalid PDU (for PDUs the switch builds itself)."
  @spec encode!(t()) :: binary()
  def encode!(pdu) do
    case encode(pdu) do
      {:ok, bin} -> bin
      {:error, reason} -> raise ArgumentError, "invalid #{pdu.command} PDU: #{inspect(reason)}"
    end
  end

  defp fetch_layout(command) do
    case Map.fetch(@layouts, command) do
      {:ok, layout} -> {:ok, layout}
      :error -> {:error, {:unknown_command, command}}
    end
  end

  # Our requests use 0..0x7FFFFFFF (spec §3.2); a response echoes whatever sequence the peer sent, so a peer that
  # breaks the range still gets its answer.
  defp check_header(%{command: command, status: status, sequence: seq}) do
    max_seq = if Command.response?(command), do: 0xFFFFFFFF, else: 0x7FFFFFFF

    cond do
      not (is_integer(seq) and seq >= 0 and seq <= max_seq) -> {:error, {:invalid_sequence, seq}}
      not valid_status?(status) -> {:error, {:invalid_status, status}}
      true -> :ok
    end
  end

  defp valid_status?(status) when is_integer(status), do: status in 0..0xFFFFFFFF

  defp valid_status?(status) when is_atom(status) do
    _ = Status.code(status)
    true
  rescue
    KeyError -> false
  end

  defp valid_status?(_), do: false

  defp check_keys(fields, layout) when is_map(fields) do
    case Map.keys(fields) -- Keyword.keys(layout) do
      [] -> :ok
      unknown -> {:error, {:unknown_fields, Enum.sort(unknown)}}
    end
  end

  defp check_keys(fields, _layout), do: {:error, {:fields_must_be_a_map, fields}}

  # Spec §5.3.2.32: message_payload and a non-empty short_message must not both be used.
  defp check_payload(%{fields: fields, tlvs: tlvs}) do
    if Map.get(fields, :short_message, "") != "" and List.keymember?(tlvs, :message_payload, 0),
      do: {:error, :short_message_and_message_payload},
      else: :ok
  end

  defp encode_body(%{command: command, status: status}, _layout)
       when command in @no_body_on_error and status != 0 and status != :esme_rok,
       do: {:ok, []}

  defp encode_body(%{fields: fields}, layout) do
    Enum.reduce_while(layout, {:ok, []}, fn {name, type}, {:ok, acc} ->
      case encode_field(type, Map.get(fields, name)) do
        {:ok, bin} -> {:cont, {:ok, [acc, bin]}}
        :error -> {:halt, {:error, {:invalid_field, name, Map.get(fields, name)}}}
      end
    end)
  end

  defp encode_field(:int8, nil), do: {:ok, <<0>>}
  defp encode_field(:int8, v) when is_integer(v) and v in 0..0xFF, do: {:ok, <<v>>}
  defp encode_field({:cstring, max, _}, v), do: encode_cstring(v, max)

  defp encode_field({:time, _}, v) do
    case v do
      nil -> {:ok, <<0>>}
      "" -> {:ok, <<0>>}
      v when is_binary(v) -> if Regex.match?(@time_format, v), do: {:ok, v <> <<0>>}, else: :error
      _ -> :error
    end
  end

  defp encode_field(:short_message, nil), do: {:ok, <<0>>}

  defp encode_field(:short_message, v) when is_binary(v) and byte_size(v) <= 254,
    do: {:ok, <<byte_size(v), v::binary>>}

  defp encode_field(:dest_addresses, list) when is_list(list) and length(list) in 1..254 do
    list
    |> Enum.map(&encode_dest_address/1)
    |> collect(<<length(list)>>)
  end

  defp encode_field(:unsuccess_smes, nil), do: {:ok, <<0>>}

  defp encode_field(:unsuccess_smes, list) when is_list(list) and length(list) <= 255 do
    list
    |> Enum.map(&encode_unsuccess_sme/1)
    |> collect(<<length(list)>>)
  end

  defp encode_field(_type, _value), do: :error

  defp encode_dest_address(%{dest_flag: 1, ton: ton, npi: npi, address: addr})
       when ton in 0..255 and npi in 0..255 do
    with {:ok, a} <- encode_cstring(addr, 21), do: {:ok, [1, ton, npi, a]}
  end

  defp encode_dest_address(%{dest_flag: 2, dl_name: name}) do
    with {:ok, n} <- encode_cstring(name, 21), do: {:ok, [2, n]}
  end

  defp encode_dest_address(_), do: :error

  defp encode_unsuccess_sme(%{ton: ton, npi: npi, address: addr, error_status_code: code})
       when ton in 0..255 and npi in 0..255 and is_integer(code) and code in 0..0xFFFFFFFF do
    with {:ok, a} <- encode_cstring(addr, 21), do: {:ok, [ton, npi, a, <<code::32>>]}
  end

  defp encode_unsuccess_sme(_), do: :error

  defp collect(results, prefix) do
    if Enum.all?(results, &match?({:ok, _}, &1)),
      do: {:ok, [prefix | Enum.map(results, &elem(&1, 1))]},
      else: :error
  end

  defp encode_cstring(nil, _max), do: {:ok, <<0>>}

  defp encode_cstring(v, max) when is_binary(v) and byte_size(v) < max do
    if String.contains?(v, <<0>>), do: :error, else: {:ok, v <> <<0>>}
  end

  defp encode_cstring(_v, _max), do: :error
end
