# contract/

The only interface between the GUI and the backend (CLAUDE.md rule 2).

| File | What |
| --- | --- |
| `openapi.yaml` | REST API, OpenAPI 3.1 |
| `events/` | WebSocket events: Phoenix Channels frames and payload JSON Schemas ([README](events/README.md)) |
| `generated/` | TypeScript types generated from the two above. **Do not edit**; run `npm run gen` |
| `index.ts` | Import point for `web/` and `mock/`: `import type { ListQuery } from "@sms/contract"` |

## Changing the contract

1. Edit `openapi.yaml` or `events/*.json`.
2. `npm run gen` to regenerate the types, then fix the type errors it causes in `web/` and `mock/`.
3. `npm run lint:contract` and `npm test`.
4. Add a row to `docs/BACKEND_TODO.md` (what changed, which spec section).
5. Bump `info.version` in `openapi.yaml` (minor for additions, major for breaking changes).

CI fails if `generated/` does not match the contract (`npm run gen:check`).

## List conventions (spec §13.25, §14.2)

Every list is read with `POST /<list>/query` and a `ListQuery` body:

```json
{
  "filter": {
    "logic": "and",
    "conditions": [
      { "field": "name", "op": "like", "value": "acme%" },
      { "logic": "or", "conditions": [
        { "field": "type", "op": "in", "values": ["customer", "reciprocal"] },
        { "field": "id", "op": "between", "values": [100, 200] }
      ] }
    ]
  },
  "search": "demo",
  "sort": [{ "field": "name", "dir": "asc" }],
  "limit": 500,
  "cursor": null
}
```

* Column filters and the filter builder produce one filter tree; groups nest for AND/OR.
* Operators: `eq neq like not_like in not_in between gt gte lt lte empty not_empty regex`.
  All text matching is case-insensitive; in `like`, `%` is any text and `_` one character.
* The response carries `rows`, `total`, `totalIsEstimate` and `nextCursor`. The grid
  scrolls with virtualisation and requests the next page with `cursor = nextCursor`.
* `GET /meta/lists/{list}/fields` describes every field of a list (hidden ones too), its
  type and allowed operators, so the filter builder needs no per-screen code.
* Unknown fields, disallowed operators or bad values return `400` with
  `application/problem+json` and an `errors[]` entry per problem.
