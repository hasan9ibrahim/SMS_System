defmodule Sms.Switch.Voice.Pjsip do
  @moduledoc """
  The voice gateways as Asterisk's PJSIP configuration (§8 SMS to voice, docs/SMS_TO_VOICE.md): the file
  `pjsip_sms_voice.conf` that `pjsip.conf` includes, with one endpoint, aor and auth per active gateway, all named
  `smsvoice-gw<id>` (calls go to `PJSIP/<number>@smsvoice-gw<id>`). Pure; `Sms.Switch.Voice.Files` writes it.

    * The endpoint takes the gateway's transport (`transport-udp`, `transport-tcp` or `transport-tls`, defined in
      `pjsip.conf` by the Ansible role asterisk), its codecs (`alaw,ulaw` when none is valid), its From domain when
      set, and `outbound_auth` only when the gateway has a username. It has no `context`: a call coming in from a
      gateway finds no dialplan and is refused.
    * The aor's contact is `sip:<host>:<port>;transport=<udp|tcp|tls>`, the URI matching the endpoint's transport.
    * Values go on one line, with `;` escaped (it starts a comment in Asterisk's configuration files). A gateway whose
      host is not a host name or address is left out and logged.
  """
  require Logger

  @header """
  ; SMS to voice (§8): the voice gateways, written by the SMS switch whenever they change, one endpoint, aor and auth
  ; per active gateway. Do not edit: the next change replaces it. Included from pjsip.conf.
  """

  @host ~r/\A(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[?[0-9A-Fa-f:.]+\]?)\z/
  @codec ~r/\A[a-z0-9_]+\z/

  @doc "The endpoint, aor and auth name of a gateway."
  @spec name(integer()) :: String.t()
  def name(gateway_id), do: "smsvoice-gw#{gateway_id}"

  @doc "The file for these gateways, in id order."
  @spec render([map()]) :: String.t()
  def render(gateways) do
    sections =
      gateways
      |> Enum.sort_by(& &1.id)
      |> Enum.filter(&valid?/1)
      |> Enum.map(&gateway/1)

    Enum.join([@header | sections], "\n")
  end

  defp valid?(g) do
    if is_binary(g.host) and Regex.match?(@host, g.host) do
      true
    else
      Logger.error(
        "voice gateway #{g.id} left out of the PJSIP configuration: host #{inspect(g.host)} is not valid"
      )

      false
    end
  end

  defp gateway(g) do
    name = name(g.id)
    auth? = g[:username] not in [nil, ""]

    endpoint =
      [
        {"type", "endpoint"},
        {"transport", "transport-#{g[:transport] || :udp}"},
        {"disallow", "all"},
        {"allow", codecs(g[:codecs])},
        {"aors", name}
      ] ++
        if(auth?, do: [{"outbound_auth", name}], else: []) ++
        if(g[:from_domain] in [nil, ""], do: [], else: [{"from_domain", g.from_domain}]) ++
        [{"direct_media", "no"}]

    aor = [{"type", "aor"}, {"contact", contact(g)}]

    auth =
      if auth?,
        do: [
          section(name, [
            {"type", "auth"},
            {"auth_type", "userpass"},
            {"username", g.username},
            {"password", g[:password] || ""}
          ])
        ],
        else: []

    Enum.join([section(name, endpoint), section(name, aor) | auth], "\n")
  end

  defp section(name, fields),
    do: "[#{name}]\n" <> Enum.map_join(fields, fn {k, v} -> "#{k}=#{value(v)}\n" end)

  defp value(v),
    do: v |> to_string() |> String.replace(["\r", "\n"], "") |> String.replace(";", "\\;")

  defp codecs(list) do
    case Enum.filter(list || [], &(is_binary(&1) and Regex.match?(@codec, &1))) do
      [] -> "alaw,ulaw"
      valid -> Enum.join(valid, ",")
    end
  end

  defp contact(g) do
    host =
      if String.contains?(g.host, ":") and not String.starts_with?(g.host, "["),
        do: "[#{g.host}]",
        else: g.host

    "sip:#{host}:#{g[:port] || 5060};transport=#{g[:transport] || :udp}"
  end
end
