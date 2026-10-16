# WebSocket events

Live data (dashboard, analytics, alerts, hover volumes) is pushed, not polled
(CLAUDE.md rule 5, spec §14.2). The wire format is **Phoenix Channels, V2 JSON
serializer**, so the mock traffic generator and the later Phoenix backend are
interchangeable for the GUI.

* Socket: `ws(s)://<host>/socket/websocket?vsn=2.0.0`
* Frame: `[join_ref, ref, topic, event, payload]` (`phoenix-message.json`)
* Client joins a topic with `phx_join`, the server replies with `phx_reply`;
  the client sends `heartbeat` on topic `phoenix` every 30 s.
* Server pushes have `ref = null`; their payload matches the schema listed in
  `catalog.json` for that topic and event.

| Topic | Event | Payload schema | Spec |
| --- | --- | --- | --- |
| `live:dashboard` | `summary` | `dashboard.summary.json` | §13.3 |
| `live:tps` | `tick` | `traffic.tps_tick.json` | §13.3, §15.1 |
| `alerts:<userId>` | `incident` | `alerts.incident.json` | §13.6 |

Shared definitions live in `common.json`. Every schema carries an `examples`
entry; the contract tests validate each example against its schema.

To add an event: add the schema file here, add it to `catalog.json` and the table
above, run `npm run gen`, and log the change in `docs/BACKEND_TODO.md`.
