defmodule Sms.Switch.Pipeline.Hlr.Http do
  @moduledoc """
  Asks an HLR / MNP provider about a number over its HTTP API (§6.5): the provider's URL, Extra Headers and Data (a
  POST body; none = GET), with `{DNID}` (the number), `{USERNAME}` and `{PASSWORD}` replaced. When the username and
  password appear in none of them they go as HTTP Basic authentication (product owner 2026-10-25). The answer is
  JSON; the provider's response mapping says where MCCMNC (or MCC and MNC), Ported and the error code are, as a field
  name or a dotted path (`original.mcc`). A lookup succeeds when the error code is absent or one of the Success Codes
  and an MCCMNC came back.

  The whole request has the provider's timeout; past it the answer is `{:error, :timeout}`.
  """
  @behaviour Sms.Switch.Pipeline.Hlr.Client

  @impl true
  def request(provider, number) do
    timeout = provider.timeout_ms
    opts = [timeout: timeout, connect_timeout: timeout, autoredirect: false]
    {method, request} = build(provider, number)

    case :httpc.request(method, request, opts, body_format: :binary) do
      {:ok, {{_, status, _}, _headers, body}} when status in 200..299 ->
        parse(body, provider.mapping)

      {:ok, {{_, status, _}, _headers, _body}} ->
        {:error, {:http, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # GET with the URL, or POST with the Data template as its body.
  defp build(provider, number) do
    url = ~c"#{fill(provider.url, provider, number, &URI.encode_www_form/1)}"
    headers = headers(provider, number)

    case provider.post_data do
      body when is_binary(body) and body != "" ->
        {:post, {url, headers, ~c"application/json", fill(body, provider, number, & &1)}}

      _ ->
        {:get, {url, headers}}
    end
  end

  defp fill(template, provider, number, encode) do
    template
    |> String.replace("{DNID}", encode.(number))
    |> String.replace("{USERNAME}", encode.(provider.username || ""))
    |> String.replace("{PASSWORD}", encode.(provider.password || ""))
  end

  defp headers(provider, number) do
    extra =
      for line <- String.split(provider.extra_headers || "", ~r/\r?\n/, trim: true),
          [name, value] <- [String.split(line, ":", parts: 2)],
          do: {~c"#{String.trim(name)}", ~c"#{String.trim(fill(value, provider, number, & &1))}"}

    if basic?(provider),
      do: [
        {~c"authorization",
         ~c"Basic " ++ ~c"#{Base.encode64("#{provider.username}:#{provider.password}")}"}
        | extra
      ],
      else: extra
  end

  # Basic authentication only when the credentials are set and no template places them itself.
  defp basic?(%{username: user} = p) when is_binary(user) and user != "" do
    templates = Enum.join([p.url, p.extra_headers || "", p.post_data || ""], "\n")

    not String.contains?(templates, "{USERNAME}") and
      not String.contains?(templates, "{PASSWORD}")
  end

  defp basic?(_provider), do: false

  @doc false
  # The provider's JSON answer through its response mapping.
  def parse(body, mapping) do
    case Jason.decode(body) do
      {:ok, json} when is_map(json) ->
        error = at(json, mapping["errorCode"])
        mccmnc = mccmnc(json, mapping)

        {:ok,
         %{
           mccmnc: mccmnc,
           ported: truthy(at(json, mapping["ported"])),
           error_code: code(error),
           accomplished: mccmnc != nil and success?(error, mapping["successCodes"])
         }}

      _ ->
        {:error, :not_json}
    end
  end

  defp mccmnc(json, mapping) do
    case to_digits(at(json, mapping["mccmnc"])) do
      code when byte_size(code) in 5..6 ->
        code

      _ ->
        with mcc when byte_size(mcc) == 3 <- to_digits(at(json, mapping["mcc"])),
             mnc when byte_size(mnc) in 2..3 <- to_digits(at(json, mapping["mnc"])),
             do: mcc <> mnc,
             else: (_ -> nil)
    end
  end

  defp at(_json, nil), do: nil
  defp at(_json, ""), do: nil

  defp at(json, path) do
    Enum.reduce_while(String.split(path, "."), json, fn key, acc ->
      case acc do
        %{^key => value} -> {:cont, value}
        _ -> {:halt, nil}
      end
    end)
  end

  defp to_digits(nil), do: ""
  defp to_digits(n) when is_integer(n), do: Integer.to_string(n)
  defp to_digits(s) when is_binary(s), do: String.replace(s, ~r/\D/, "")
  defp to_digits(_), do: ""

  defp truthy(v) when v in [true, 1, "1", "true", "TRUE", "yes", "Y", "y"], do: true
  defp truthy(v) when v in [false, 0, "0", "false", "FALSE", "no", "N", "n"], do: false
  defp truthy(_), do: nil

  defp code(nil), do: 0

  defp code(v) do
    case Integer.parse(to_string(v)) do
      {n, _} when n >= 0 and n <= 65_535 -> n
      _ -> 0
    end
  end

  defp success?(nil, _codes), do: true

  defp success?(error, codes) do
    allowed = String.split(codes || "0", ",", trim: true) |> Enum.map(&String.trim/1)
    to_string(error) in allowed
  end
end

defmodule Sms.Switch.Pipeline.Hlr.Client do
  @moduledoc false
  # How the switch asks a provider (`Sms.Switch.Pipeline.Hlr.Http`; tests put a fake one in its place).
  @callback request(provider :: map(), number :: String.t()) ::
              {:ok,
               %{
                 accomplished: boolean(),
                 mccmnc: String.t() | nil,
                 ported: boolean() | nil,
                 error_code: integer()
               }}
              | {:error, term()}
end
