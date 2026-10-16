// Typed API client. Paths, bodies and responses are checked against the types
// generated from contract/openapi.yaml, so a contract change shows up as a type error.
import createClient from "openapi-fetch";
import type { paths } from "@sms/contract";

export const api = createClient<paths>({ baseUrl: "/api/v1" });
