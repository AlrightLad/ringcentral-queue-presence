import { test } from "node:test";
import assert from "node:assert/strict";
import { QueuePresenceClient } from "../src/client.ts";
import type { Credentials } from "../src/auth.ts";

const creds: Credentials = { serverUrl: "https://rc.example", clientId: "cid", clientSecret: "sec", jwt: "jwt" };

type Rec = { member: { id: number; extensionNumber: string; name: string }; acceptQueueCalls: boolean; acceptCurrentQueueCalls: boolean };

/** A fake RingCentral: a token endpoint and one queue whose presence a PUT mutates. */
function fakeRc(opts: { applyWrites?: boolean; firstGet401?: boolean } = {}) {
  const queue: Rec[] = [
    { member: { id: 1, extensionNumber: "1006", name: "<ENGINEER_6>" }, acceptQueueCalls: true, acceptCurrentQueueCalls: false },
    { member: { id: 2, extensionNumber: "1001", name: "<ENGINEER_1>" }, acceptQueueCalls: true, acceptCurrentQueueCalls: false },
    { member: { id: 3, extensionNumber: "1005", name: "<ENGINEER_5>" }, acceptQueueCalls: true, acceptCurrentQueueCalls: true },
    { member: { id: 4, extensionNumber: "1004", name: "<ENGINEER_4>" }, acceptQueueCalls: false, acceptCurrentQueueCalls: true },
  ];
  const log: { method: string; url: string; body: any }[] = [];
  let mints = 0, gets = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    const body = init?.body ? (typeof init.body === "string" ? JSON.parse(init.body) : String(init.body)) : null;
    log.push({ method, url, body });
    if (url.endsWith("/restapi/oauth/token")) { mints++; return Response.json({ access_token: `tok-${mints}`, expires_in: 3600 }); }
    if (url.includes("/presence")) {
      if (method === "GET") {
        gets++;
        if (opts.firstGet401 && gets === 1) return new Response("expired", { status: 401 });
        return Response.json({ records: queue });
      }
      if (method === "PUT") {
        if (opts.applyWrites !== false) for (const r of body.records) { const q = queue.find((x) => String(x.member.id) === String(r.member.id)); if (q) q.acceptCurrentQueueCalls = r.acceptCurrentQueueCalls; }
        return Response.json({ records: queue });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { queue, log, fetchImpl, mints: () => mints };
}

const mk = (rc: ReturnType<typeof fakeRc>, writeEnabled: boolean) => new QueuePresenceClient({
  credentials: creds, accountId: "acct", queueId: "q", protectedMemberIds: ["1"], writeEnabled, fetchImpl: rc.fetchImpl,
});

test("the client refuses to exist without an account and a queue id", () => {
  assert.throws(() => new QueuePresenceClient({ credentials: creds, accountId: "", queueId: "q" }), /refusing to guess/);
});

test("read: one mint, one GET, members normalized", async () => {
  const rc = fakeRc();
  const members = await mk(rc, false).read();
  assert.equal(members.length, 4);
  assert.equal(rc.mints(), 1);
  assert.equal(rc.log.filter((l) => l.method === "GET").length, 1);
});

test("apply with writes disabled is a dry run: computed and reported, no PUT", async () => {
  const rc = fakeRc();
  const r = await mk(rc, false).apply({ ext: "1001", id: "2" });
  assert.equal(r.written, false);
  assert.equal(r.dry_run, true);
  assert.match(r.why ?? "", /writes are disabled/);
  assert.deepEqual(r.changes.map((c) => [c.ext, c.after]), [["1001", true], ["1005", false], ["1004", false]]);
  assert.equal(rc.log.filter((l) => l.method === "PUT").length, 0);
  assert.equal(r.before.find((b) => b.ext === "1006")!.protected, true);
});

test("apply with writes enabled: every non-protected member is sent explicitly, then the read-back confirms", async () => {
  const rc = fakeRc();
  const r = await mk(rc, true).apply({ ext: "1001", id: "2" });
  assert.equal(r.written, true);
  const put = rc.log.find((l) => l.method === "PUT")!;
  assert.deepEqual(put.body.records.map((x: any) => [x.member.id, x.acceptCurrentQueueCalls]), [["2", true], ["3", false], ["4", false]]);
  assert.ok(!put.body.records.some((x: any) => x.member.id === "1"), "the protected member is never in the payload");
  assert.equal(r.after!.find((m) => m.ext === "1001")!.acceptCurrentQueueCalls, true);
  assert.equal(r.after!.find((m) => m.ext === "1005")!.acceptCurrentQueueCalls, false);
});

test("a write the API accepted but did not apply throws, naming the rows the read-back did not confirm", async () => {
  const rc = fakeRc({ applyWrites: false });
  await assert.rejects(() => mk(rc, true).apply({ ext: "1001", id: "2" }), /did not apply the presence: <ENGINEER_1> \(x1001\) wanted true, <ENGINEER_5> \(x1005\) wanted false, <ENGINEER_4> \(x1004\) wanted false/);
});

test("a queue that already matches is left alone and says so", async () => {
  const rc = fakeRc();
  rc.queue[3].acceptCurrentQueueCalls = false; // only x1005 enabled
  const r = await mk(rc, true).apply({ ext: "1005", id: "3" });
  assert.equal(r.written, false);
  assert.match(r.why ?? "", /already matches/);
  assert.equal(rc.log.filter((l) => l.method === "PUT").length, 0);
});

test("a protected holder and an absent holder both block the write, with different explanations", async () => {
  const rc = fakeRc();
  const prot = await mk(rc, true).apply({ ext: "1006", id: "1" });
  assert.equal(prot.written, false);
  assert.equal(prot.holder_protected, true);
  assert.match(prot.why ?? "", /protected member/);
  const absent = await mk(rc, true).apply({ ext: "9999", name: "New Hire" });
  assert.equal(absent.written, false);
  assert.equal(absent.holder_protected, false);
  assert.match(absent.why ?? "", /not a member of the queue/);
  assert.equal(rc.log.filter((l) => l.method === "PUT").length, 0);
});

test("a 401 on a read triggers exactly one fresh mint and a retry", async () => {
  const rc = fakeRc({ firstGet401: true });
  const members = await mk(rc, false).read();
  assert.equal(members.length, 4);
  assert.equal(rc.mints(), 2);
  assert.equal(rc.log.filter((l) => l.method === "GET" && l.url.includes("/presence")).length, 2);
});

test("restore replays a captured snapshot verbatim and verifies it", async () => {
  const rc = fakeRc();
  const snapshot = [{ id: "2", ext: "1001", acceptCurrentQueueCalls: true }, { id: "3", ext: "1005", acceptCurrentQueueCalls: false }, { id: "1", ext: "1006", acceptCurrentQueueCalls: true }];
  const r = await mk(rc, true).restore(snapshot);
  assert.equal(r.written, true);
  const put = rc.log.find((l) => l.method === "PUT")!;
  assert.deepEqual(put.body.records.map((x: any) => [x.member.id, x.acceptCurrentQueueCalls]), [["2", true], ["3", false]]);
});
