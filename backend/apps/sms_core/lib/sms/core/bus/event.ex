defmodule Sms.Core.Bus.Event do
  @moduledoc """
  The envelope of every event on the bus. `id` is unique and doubles as the de-duplication key: publishing the same
  id twice within the stream's duplicate window stores the event once. `version` is the version of `data`'s shape for
  that `type`, so consumers can read old and new events side by side during an upgrade.
  """

  @enforce_keys [:id, :type, :subject, :occurred_at, :version, :data]
  defstruct [:id, :type, :subject, :occurred_at, :version, :source, :data]

  @type t :: %__MODULE__{
          id: String.t(),
          type: String.t(),
          subject: String.t(),
          occurred_at: DateTime.t(),
          version: pos_integer(),
          source: String.t() | nil,
          data: map()
        }

  @doc "A new event with a fresh id and the current time."
  @spec new(String.t(), String.t(), map(), keyword()) :: t()
  def new(subject, type, data, opts \\ []) do
    %__MODULE__{
      id: Keyword.get_lazy(opts, :id, &Ecto.UUID.generate/0),
      type: type,
      subject: subject,
      occurred_at: Keyword.get_lazy(opts, :occurred_at, fn -> DateTime.utc_now() end),
      version: Keyword.get(opts, :version, 1),
      source: Keyword.get(opts, :source, Atom.to_string(node())),
      data: data
    }
  end

  @spec encode(t()) :: String.t()
  def encode(%__MODULE__{} = e) do
    Jason.encode!(%{
      id: e.id,
      type: e.type,
      subject: e.subject,
      occurred_at: DateTime.to_iso8601(e.occurred_at),
      version: e.version,
      source: e.source,
      data: e.data
    })
  end

  @doc "Decodes and checks an envelope; anything malformed is an error, never a crash."
  @spec decode(binary()) :: {:ok, t()} | {:error, term()}
  def decode(payload) when is_binary(payload) do
    with {:ok, map} when is_map(map) <- Jason.decode(payload),
         {:ok, id} <- field(map, "id", &non_empty?/1),
         {:ok, type} <- field(map, "type", &non_empty?/1),
         {:ok, subject} <- field(map, "subject", &non_empty?/1),
         {:ok, at} <- field(map, "occurred_at", &is_binary/1),
         {:ok, occurred_at, _offset} <- DateTime.from_iso8601(at),
         {:ok, version} <- field(map, "version", &(is_integer(&1) and &1 > 0)),
         {:ok, data} <- field(map, "data", &is_map/1) do
      source = map["source"]

      {:ok,
       %__MODULE__{
         id: id,
         type: type,
         subject: subject,
         occurred_at: occurred_at,
         version: version,
         source: if(is_binary(source), do: source),
         data: data
       }}
    else
      {:ok, _not_a_map} -> {:error, :not_an_object}
      {:error, %Jason.DecodeError{}} -> {:error, :invalid_json}
      {:error, reason} -> {:error, reason}
    end
  end

  defp field(map, key, valid?) do
    value = Map.get(map, key)
    if valid?.(value), do: {:ok, value}, else: {:error, {:invalid_field, key}}
  end

  defp non_empty?(v), do: is_binary(v) and v != ""
end
