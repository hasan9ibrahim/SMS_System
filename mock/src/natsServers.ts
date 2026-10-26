// Where and as whom the service connects to NATS (live screens, switch commands; backend steps 11 and 11c). NATS_URL is
// a comma-separated list such as nats://sms:password@127.0.0.1:4222 (deploy/ansible roles/service). nats.js ignores a
// login written in the URL, so it is taken out of the URLs and passed as user and pass (go-live rehearsal 2026-10-26:
// with it left in the URL every connection was refused, "Authorization Violation").

export interface NatsServers {
  servers: string[];
  user?: string;
  pass?: string;
}

export function natsServers(urls = process.env.NATS_URL ?? "nats://127.0.0.1:4222"): NatsServers {
  let user: string | undefined;
  let pass: string | undefined;
  const servers = urls
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const u = new URL(s);
      if (u.username && user === undefined) {
        user = decodeURIComponent(u.username);
        pass = decodeURIComponent(u.password);
      }
      return `${u.protocol}//${u.host}`;
    });
  return user === undefined ? { servers } : { servers, user, pass };
}
