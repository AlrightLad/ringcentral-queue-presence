// One cached bearer, not one per call.
//
// RingCentral limits token mints per application to a handful per minute (observed in
// production as HTTP 429 with x-rate-limit-remaining: 0 after a few back-to-back runs that
// each minted their own token). A bearer is valid for about an hour, so every caller must
// share one and re-mint only when it is about to expire or a request comes back 401.

export type Credentials = {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  /** JWT credential issued to the app (grant urn:ietf:params:oauth:grant-type:jwt-bearer). Preferred. */
  jwt?: string | null;
  /** Legacy password grant, used only when jwt is empty. */
  username?: string | null;
  extension?: string | null;
  password?: string | null;
};

export type Token = { token: string; obtainedAt: number; expiresIn: number };

/** Where the shared bearer lives. In-process by default; give the client a file or secret-store implementation to share across processes. */
export interface TokenStore {
  get(): Promise<Token | null> | Token | null;
  set(t: Token): Promise<void> | void;
}

export class MemoryTokenStore implements TokenStore {
  private t: Token | null = null;
  get(): Token | null { return this.t; }
  set(t: Token): void { this.t = t; }
}

/** Re-mint this long before the token's own expiry so a request never carries a bearer that dies mid-flight. */
export const REFRESH_SKEW_MS = 120_000;

export function tokenIsFresh(t: Token | null, now: number = Date.now()): boolean {
  if (!t || !t.token) return false;
  const ttlMs = (Number(t.expiresIn) || 3600) * 1000;
  return now - Number(t.obtainedAt) < ttlMs - REFRESH_SKEW_MS;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export const serverOf = (c: Credentials): string => String(c.serverUrl || "https://platform.ringcentral.com").replace(/\/$/, "");

/** Mint a bearer: JWT grant when a jwt is configured, otherwise the password grant. Throws with the server's reason on failure. */
export async function mintToken(creds: Credentials, fetchImpl: FetchLike = fetch, now: number = Date.now()): Promise<Token> {
  const body = filled(creds.jwt)
    ? new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: creds.jwt })
    : filled(creds.username) && filled(creds.password)
      ? new URLSearchParams({ grant_type: "password", username: creds.username, password: creds.password, ...(filled(creds.extension) ? { extension: creds.extension } : {}) })
      : null;
  if (!body) throw new Error("RingCentral credentials have neither a jwt nor a username/password");
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const r = await fetchImpl(`${serverOf(creds)}/restapi/oauth/token`, {
    method: "POST",
    body,
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) {
    throw new Error(`RingCentral auth failed (HTTP ${r.status}): ${j?.error_description ?? j?.error ?? j?.message ?? "no access_token"}`);
  }
  return { token: String(j.access_token), obtainedAt: now, expiresIn: Number(j.expires_in) || 3600 };
}

/** The shared bearer: cached while fresh, re-minted two minutes before expiry or when the caller insists (after a 401). */
export async function getBearer(
  creds: Credentials,
  store: TokenStore,
  opts: { fresh?: boolean; fetchImpl?: FetchLike; now?: () => number } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  if (!opts.fresh) {
    const cached = await store.get();
    if (tokenIsFresh(cached, now())) return cached!.token;
  }
  const t = await mintToken(creds, opts.fetchImpl ?? fetch, now());
  await store.set(t);
  return t.token;
}
