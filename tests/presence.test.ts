import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRc, planPresence, restorePlan, unconfirmed, flagIsOn, isProtected, toRecords, type Member } from "../src/presence.ts";

const m = (id: string, ext: string, name: string, cur: boolean | null, acc: boolean | null = true): Member =>
  ({ id, ext, name, acceptQueueCalls: acc, acceptCurrentQueueCalls: cur });

// A six-member queue: one standing-escalation member (protected) and five rotation members.
const ESC = m("e1", "1006", "<ENGINEER_6>", false);
const Q: Member[] = [ESC, m("a1", "1001", "<ENGINEER_1>", false), m("a2", "1002", "<ENGINEER_2>", false), m("a5", "1005", "<ENGINEER_5>", true), m("a4", "1004", "<ENGINEER_4>", true), m("a3", "1003", "<ENGINEER_3>", false)];
const PROT_IDS = new Set(["e1"]), PROT_EXTS = new Set(["1006"]);

test("normalizeRc keeps unknown flags as null, never false, and reads ids as strings", () => {
  const out = normalizeRc({ records: [{ member: { id: 7, extensionNumber: "1005", name: "Someone" } }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "7");
  assert.equal(out[0].ext, "1005");
  assert.equal(out[0].acceptQueueCalls, null);
  assert.equal(out[0].acceptCurrentQueueCalls, null);
  assert.deepEqual(normalizeRc(null), []);
  assert.deepEqual(normalizeRc({ records: "nope" }), []);
});

test("the plan sends EVERY non-protected member explicitly: holder true, everyone else false, protected never present", () => {
  const p = planPresence(Q, { ext: "1001", id: "a1" }, PROT_IDS, PROT_EXTS);
  assert.equal(p.rows.length, 5);
  assert.ok(!p.rows.some((r) => r.id === "e1"));
  assert.equal(p.rows.find((r) => r.id === "a1")!.after, true);
  assert.equal(p.rows.filter((r) => r.after === false).length, 4);
  assert.equal(p.holder_in_queue, true);
  assert.equal(p.holder_protected, false);
  assert.deepEqual(p.protected.map((x) => x.ext), ["1006"]);
});

test("changes are only the members whose value differs", () => {
  const p = planPresence(Q, { ext: "1001" }, PROT_IDS, PROT_EXTS);
  assert.deepEqual(p.changes.map((r) => [r.ext, r.after]), [["1001", true], ["1005", false], ["1004", false]]);
});

test("idempotent: a queue that already matches yields no changes but still a full row set", () => {
  const already = Q.map((x) => (x.ext === "1004" ? { ...x, acceptCurrentQueueCalls: false } : x));
  const p = planPresence(already, { ext: "1005" }, PROT_IDS, PROT_EXTS);
  assert.equal(p.changes.length, 0);
  assert.equal(p.rows.length, 5);
});

test("a holder who is not a queue member: holder_in_queue false, holder_protected false", () => {
  const p = planPresence(Q, { ext: "9999", name: "New Hire" }, PROT_IDS, PROT_EXTS);
  assert.equal(p.holder_in_queue, false);
  assert.equal(p.holder_protected, false);
});

test("a PROTECTED holder is told apart from an ABSENT one", () => {
  const p = planPresence(Q, { ext: "1006", id: "e1" }, PROT_IDS, PROT_EXTS);
  assert.equal(p.holder_in_queue, false);
  assert.equal(p.holder_protected, true);
});

test("protection matches by id OR by extension", () => {
  assert.equal(isProtected(ESC, new Set(["e1"]), new Set()), true);
  assert.equal(isProtected(ESC, new Set(), new Set(["1006"])), true);
  assert.equal(isProtected(ESC, new Set(), new Set()), false);
  assert.equal(planPresence(Q, { ext: "1001" }, new Set(["e1", "a4"]), PROT_EXTS).rows.length, 4);
});

test("members without an id cannot be written and are reported as protected-by-omission", () => {
  const q = [...Q, { id: null, ext: "1234", name: "Ghost", acceptQueueCalls: true, acceptCurrentQueueCalls: true }];
  const p = planPresence(q, { ext: "1001" }, PROT_IDS, PROT_EXTS);
  assert.equal(p.rows.length, 5);
  assert.ok(p.protected.some((x) => x.ext === "1234"));
});

test("restore replays captured values verbatim, skips protected members and members no longer in the queue, recomputes nothing", () => {
  const snap = [
    { id: "e1", ext: "1006", acceptCurrentQueueCalls: true },
    { id: "a1", ext: "1001", acceptCurrentQueueCalls: true },
    { id: "a5", ext: "1005", acceptCurrentQueueCalls: false },
    { id: "zz", ext: "1", acceptCurrentQueueCalls: true },
  ];
  const r = restorePlan(snap, Q, PROT_IDS, PROT_EXTS);
  assert.deepEqual(r.rows.map((x) => [x.ext, x.after]), [["1001", true], ["1005", false]]);
  assert.deepEqual(r.changes.map((x) => x.ext), ["1001", "1005"]);
});

test("restore ignores snapshot entries whose value is unknown (null)", () => {
  const r = restorePlan([{ id: "a1", ext: "1001", acceptCurrentQueueCalls: null }], Q, PROT_IDS, PROT_EXTS);
  assert.equal(r.rows.length, 0);
});

test("unconfirmed names exactly the rows the read-back did not confirm", () => {
  const rows = [{ id: "a1", ext: "1001", name: "<ENGINEER_1>", before: false, after: true }, { id: "a5", ext: "1005", name: "<ENGINEER_5>", before: true, after: false }];
  const after = [m("a1", "1001", "<ENGINEER_1>", false), m("a5", "1005", "<ENGINEER_5>", false)];
  assert.equal(unconfirmed(rows, after), "<ENGINEER_1> (x1001) wanted true");
  assert.equal(unconfirmed(rows, [m("a1", "1001", "x", true), m("a5", "1005", "y", false)]), "no row disagreed, but the read-back was incomplete");
});

test("the PUT body carries one record per planned row", () => {
  const body = toRecords([{ id: "a1", ext: "1001", name: "n", before: false, after: true }]);
  assert.deepEqual(body, { records: [{ member: { id: "a1" }, acceptCurrentQueueCalls: true }] });
});

test("the write switch arms on the exact string \"true\" and nothing else", () => {
  assert.deepEqual(["true", " TRUE ", "yes", "1", "on", "", null, undefined].map(flagIsOn), [true, true, false, false, false, false, false, false]);
});
