defmodule Sms.Api.Lists.Catalog do
  @moduledoc """
  Every list's field catalogue (§13.25: the fields a list can be filtered and sorted on, their types and operators),
  read at compile time from contract/generated/lists.json, which the mock writes from the same catalogue it serves at
  GET /meta/lists/{list}/fields (`npm run gen:lists -w mock`; a mock test keeps it current).
  """

  @file_path Path.expand("../../../../../../../contract/generated/lists.json", __DIR__)
  @external_resource @file_path
  @lists @file_path |> File.read!() |> Jason.decode!()

  @doc "The catalogue of a list (`list`, `defaultSort`, `fields`), or nil."
  @spec fields(String.t()) :: map() | nil
  def fields(list), do: Map.get(@lists, list)
end
