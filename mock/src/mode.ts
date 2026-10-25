// Production or the team trial (backend step 11, product owner 2026-10-25: go live with the Elixir switch and API in
// front of this service). SMS_MODE=production:
//
//   * no fake traffic: the live screens come from the switch's events on NATS (live/feed.ts), not the simulator, and
//     no simulated EDRs are written; bind status comes from the switch's session events;
//   * no invented data: the fake vendor-invoice mailbox, team presence and targets, HLR health profile, simulated
//     exchange rates, demo user and the deliberate job delays are off;
//   * every request needs a signed-in user (from the API, or the session cookie); the secrets must be set;
//   * real e-mail through the business companies' mailboxes;
//   * the background jobs run on one server at a time (jobs/leader.ts).
//
// Anything else (development, tests, the team trial on fake data) keeps the demo behaviour.
export const production = process.env.SMS_MODE === "production";

/** What production needs from the environment; the service refuses to start without it. */
export function productionProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const need = (name: string, why: string) => {
    if (!env[name]) problems.push(`${name} is not set (${why})`);
  };
  need("MOCK_PROXY_SECRET", "the secret the Elixir API sends with each forwarded call");
  need("MOCK_SECRET_KEY", "the key that encrypts trunk and mailbox passwords");
  if (env.MOCK_SECRET_KEY === "dev-only-not-a-real-key") problems.push("MOCK_SECRET_KEY is the development key");
  need("NATS_URL", "the switch's events for the live screens, bind status and credit alerts");
  need("PUBLIC_URL", "the address in e-mailed links");
  if (env.MOCK_USER_ID) problems.push("MOCK_USER_ID must not be set in production (every request has its own user)");
  return problems;
}
