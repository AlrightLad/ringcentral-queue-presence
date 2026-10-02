import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTokenStore, REFRESH_SKEW_MS, getBearer, mintToken, tokenIsFresh, type Credentials } from "../src/auth.ts";

const creds: Credentials = { serverUrl: "https://rc.example", clientId: "cid", clientSecret: "sec", jwt: "jwt-assertion" };

function fakeTokenServer(expiresIn = 3600) {
  const calls: { url: string; body: string; auth: string }[] = [];
  let n = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    n++;
    calls.push({ url, body: String(init?.body), auth: String((init?.headers as any)?.authorization ?? "") });
    return new Response(JSON.stringify({ access_token: `tok-${n}`, expires_in: expiresIn }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl, count: () => n };
}

test("tokenIsFresh: fresh until two minutes before expiry, never for a missing token", () => {
  const t = { token: "x", obtainedAt: 1_000_000, expiresIn: 3600 };
  assert.equal(tokenIsFresh(null), false);
  assert.equal(tokenIsFresh(t, 1_000_000 + 1000), true);
  assert.equal(tokenIsFresh(t, 1_000_000 + 3600_000 - REFRESH_SKEW_MS - 1), true);
  assert.equal(tokenIsFresh(t, 1_000_000 + 3600_000 - REFRESH_SKEW_MS), false);
});

test("mintToken uses the JWT grant when a jwt is configured", async () => {
  const s = fakeTokenServer();
  const t = await mintToken(creds, s.fetchImpl, 5);
  assert.equal(t.token, "tok-1");
  assert.equal(t.obtainedAt, 5);
  assert.equal(s.calls[0].url, "https://rc.example/restapi/oauth/token");
  assert.match(s.calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  assert.match(s.calls[0].auth, /^Basic /);
});

test("mintToken falls back to the password grant only when no jwt is set, and refuses with neither", async () => {
  const s = fakeTokenServer();
  await mintToken({ ...creds, jwt: null, username: "u", password: "p", extension: "101" }, s.fetchImpl);
  assert.match(s.calls[0].body, /grant_type=password/);
  assert.match(s.calls[0].body, /extension=101/);
  await assert.rejects(() => mintToken({ ...creds, jwt: null }, s.fetchImpl), /neither a jwt nor a username\/password/);
});

test("mintToken surfaces the server's reason on failure", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed" }), { status: 400 });
  await assert.rejects(() => mintToken(creds, fetchImpl), /HTTP 400.*Client authentication failed/);
});

test("getBearer mints once and serves the cache: three calls, one mint", async () => {
  const s = fakeTokenServer();
  const store = new MemoryTokenStore();
  let now = 1_000_000;
  const opts = { fetchImpl: s.fetchImpl, now: () => now };
  assert.equal(await getBearer(creds, store, opts), "tok-1");
  now += 60_000;
  assert.equal(await getBearer(creds, store, opts), "tok-1");
  now += 60_000;
  assert.equal(await getBearer(creds, store, opts), "tok-1");
  assert.equal(s.count(), 1);
});

test("getBearer re-mints when the cached token is inside the refresh skew, and when the caller insists", async () => {
  const s = fakeTokenServer(600);
  const store = new MemoryTokenStore();
  let now = 1_000_000;
  const opts = { fetchImpl: s.fetchImpl, now: () => now };
  await getBearer(creds, store, opts);
  now += 600_000 - REFRESH_SKEW_MS + 1;
  assert.equal(await getBearer(creds, store, opts), "tok-2");
  assert.equal(await getBearer(creds, store, { ...opts, fresh: true }), "tok-3");
  assert.equal(s.count(), 3);
});
