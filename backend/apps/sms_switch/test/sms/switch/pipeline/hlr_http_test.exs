defmodule Sms.Switch.Pipeline.HlrHttpTest do
  # The HLR provider client against a real HTTP server on loopback (fake data): templates, credentials, the response
  # mapping, errors and the timeout (§6.5, product owner 2026-10-25).
  use ExUnit.Case, async: true
  alias Sms.Switch.Pipeline.Hlr.Http
  alias Sms.Switch.Test.PipelineConfig

  # Answers each request with `{status, body, delay_ms}` and sends the raw request to the test.
  defp serve(status, body, delay \\ 0) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    test = self()

    spawn_link(fn ->
      {:ok, socket} = :gen_tcp.accept(listen)
      {:ok, request} = read_request(socket, "")
      send(test, {:request, request})
      Process.sleep(delay)

      reply =
        "HTTP/1.1 #{status} X\r\ncontent-length: #{byte_size(body)}\r\nconnection: close\r\n\r\n#{body}"

      :gen_tcp.send(socket, reply)
      Process.sleep(100)
      :gen_tcp.close(socket)
    end)

    port
  end

  defp read_request(socket, acc) do
    with {:ok, data} <- :gen_tcp.recv(socket, 0, 2_000) do
      acc = acc <> data
      if complete?(acc), do: {:ok, acc}, else: read_request(socket, acc)
    end
  end

  defp complete?(request) do
    case String.split(request, "\r\n\r\n", parts: 2) do
      [head, body] -> byte_size(body) >= content_length(head)
      _ -> false
    end
  end

  defp content_length(head) do
    case Regex.run(~r/content-length: (\d+)/i, head) do
      [_, n] -> String.to_integer(n)
      nil -> 0
    end
  end

  defp provider(port, fields \\ []) do
    raw =
      PipelineConfig.hlr_provider(
        [url: "http://127.0.0.1:#{port}/lookup?msisdn={DNID}"] ++ fields
      )

    %{raw | response_mapping: raw.response_mapping} |> Map.put(:mapping, raw.response_mapping)
  end

  test "GET with the number in the URL; username and password as Basic when no template uses them" do
    port = serve(200, ~s({"mccmnc":"26202","ported":true}))
    p = provider(port, username: "user1", password: "fake-pass")

    assert {:ok, %{accomplished: true, mccmnc: "26202", ported: true, error_code: 0}} =
             Http.request(p, "4915112345678")

    assert_receive {:request, request}
    assert request =~ "GET /lookup?msisdn=4915112345678 HTTP/1.1"
    assert request =~ "authorization: Basic " <> Base.encode64("user1:fake-pass")
  end

  test "POST with the body template; credentials in the template are not sent again as Basic" do
    port = serve(200, ~s({"result":{"mcc":"262","mnc":"02"},"error":{"code":"1"},"ported":"no"}))

    p =
      provider(port,
        username: "user1",
        password: "fake-pass",
        post_data: ~s({"number":"{DNID}","user":"{USERNAME}","pass":"{PASSWORD}"}),
        extra_headers: "X-Api: key-{USERNAME}",
        response_mapping: %{
          "mcc" => "result.mcc",
          "mnc" => "result.mnc",
          "ported" => "ported",
          "errorCode" => "error.code",
          "successCodes" => "0, 1"
        }
      )

    assert {:ok, %{accomplished: true, mccmnc: "26202", ported: false, error_code: 1}} =
             Http.request(p, "4915112345678")

    assert_receive {:request, request}
    assert request =~ "POST /lookup"
    assert request =~ ~s({"number":"4915112345678","user":"user1","pass":"fake-pass"})
    assert request =~ "x-api: key-user1"
    refute request =~ "authorization"
  end

  test "an error code outside the success codes, or no network, is not a result" do
    port = serve(200, ~s({"mccmnc":"26202","error":{"code":"7"}}))
    assert {:ok, %{accomplished: false, error_code: 7}} = Http.request(provider(port), "491")

    port = serve(200, ~s({"error":{"code":"0"}}))
    assert {:ok, %{accomplished: false, mccmnc: nil}} = Http.request(provider(port), "491")
  end

  test "no answer within the provider's timeout; an HTTP error; an answer that is not JSON" do
    port = serve(200, ~s({"mccmnc":"26202"}), 800)
    assert {:error, :timeout} = Http.request(provider(port, timeout_ms: 200), "491")

    port = serve(503, "busy")
    assert {:error, {:http, 503}} = Http.request(provider(port), "491")

    port = serve(200, "<html>")
    assert {:error, :not_json} = Http.request(provider(port), "491")

    {:ok, listen} = :gen_tcp.listen(0, [])
    {:ok, closed} = :inet.port(listen)
    :gen_tcp.close(listen)
    assert {:error, _} = Http.request(provider(closed), "491")
  end

  # Security audit (team trial round 12): outside the tests only public addresses are asked.
  test "loopback, private, link-local and non-http addresses are refused" do
    for url <- [
          "http://127.0.0.1:8123/?query={DNID}",
          "http://10.0.0.5/x?n={DNID}",
          "http://192.168.1.10/x",
          "http://169.254.169.254/latest",
          "http://localhost/x",
          "ftp://203.0.113.9/x",
          "not a url"
        ] do
      refute Http.public_target?(url, false), url
    end

    assert Http.public_target?("https://203.0.113.9/lookup?msisdn={DNID}", false)
    assert Http.public_target?("http://127.0.0.1:1/x", true)
  end
end
