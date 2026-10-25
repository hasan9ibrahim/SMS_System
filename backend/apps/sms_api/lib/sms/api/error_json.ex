defmodule Sms.Api.ErrorJSON do
  @moduledoc "Errors raised while handling a request (an unreadable JSON body, a crash) as problem documents."
  alias Plug.Conn.Status

  @doc false
  def render(template, _assigns) do
    status = template |> String.split(".") |> hd() |> String.to_integer()
    %{type: "about:blank", title: Status.reason_phrase(status), status: status}
  end
end
