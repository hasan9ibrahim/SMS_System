defmodule Sms.Api.Operations do
  @moduledoc """
  The contract's operations and what each needs from the user's GUI Access Group (backend step 9), read at compile
  time from contract/generated/operations.json (made by `npm run gen` from openapi.yaml and access.json):
  `module` (the page; nil = open to any signed-in user), `action` (nil = a read), `readChecked` (an Admin page: View
  is needed even to read).

  A request path (under /api/v1) is matched to its operation; a literal segment wins over a parameter, as
  `/users/force-password-change` over `/users/{id}`.
  """

  @file_path Path.expand("../../../../../../contract/generated/operations.json", __DIR__)
  @external_resource @file_path

  @type t :: %{
          operation_id: String.t(),
          tag: String.t() | nil,
          path: String.t(),
          module: String.t() | nil,
          action: String.t() | nil,
          read_checked: boolean()
        }

  @operations @file_path
              |> File.read!()
              |> Jason.decode!()
              |> Enum.map(fn op ->
                segments =
                  op["path"]
                  |> String.split("/", trim: true)
                  |> Enum.map(fn s -> if String.starts_with?(s, "{"), do: :param, else: s end)

                {op["method"], segments,
                 %{
                   operation_id: op["operationId"],
                   tag: op["tag"],
                   path: op["path"],
                   module: op["module"],
                   action: op["action"],
                   read_checked: op["readChecked"]
                 }}
              end)
              |> Enum.sort_by(fn {_, segments, _} -> Enum.count(segments, &(&1 == :param)) end)

  @doc "The operation of a method and a path under /api/v1 (e.g. \"/enterprises/12\"), or nil."
  @spec find(String.t(), String.t()) :: t() | nil
  def find(method, path) do
    parts = String.split(path, "/", trim: true)

    Enum.find_value(@operations, fn {m, segments, op} ->
      if m == method and segments_match?(segments, parts), do: op
    end)
  end

  @doc "Every operation (for tests and tools)."
  @spec all() :: [t()]
  def all, do: Enum.map(@operations, &elem(&1, 2))

  defp segments_match?([], []), do: true
  defp segments_match?([:param | rest], [_ | parts]), do: segments_match?(rest, parts)
  defp segments_match?([same | rest], [same | parts]), do: segments_match?(rest, parts)
  defp segments_match?(_segments, _parts), do: false
end
