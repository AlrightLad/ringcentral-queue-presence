import { type Credentials, type FetchLike, type TokenStore, MemoryTokenStore, getBearer, serverOf } from "./auth.ts";
import { type Holder, type Member, type Plan, type PlanRow, type Snapshot, normalizeRc, planPresence, restorePlan, toRecords, unconfirmed, isProtected } from "./presence.ts";

export type ClientOptions = {
  credentials: Credentials;
  /** Required. There is no default: a half-filled configuration must never write a real queue by accident. */
  accountId: string;
  /** Required. Same rule. */
  queueId: string;
  /** Members that are never written, in either direction: a standing escalation extension, for instance. */
  protectedMemberIds?: string[];
  protectedExtensions?: string[];
  /** The write switch. Off means every apply() is a dry run: computed, reported, nothing sent. */
  writeEnabled?: boolean;
  tokenStore?: TokenStore;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export type Captured = { id: string | null; ext: string; name: string; acceptCurrentQueueCalls: boolean | null; protected: boolean }[];

export type ApplyResult = {
  written: boolean;
  dry_run: boolean;
  why: string | null;
  holder: Holder;
  holder_in_queue: boolean;
  holder_protected: boolean;
  before: Captured;
  changes: PlanRow[];
  sent: PlanRow[];
  after: Member[] | null;
  protected: Plan["protected"];
};

export type RestoreResult = {
  written: boolean;
  dry_run: boolean;
  why: string | null;
  before: Captured;
  changes: PlanRow[];
  sent: PlanRow[];
  after: Member[] | null;
};

export class QueuePresenceClient {
  private readonly o: ClientOptions;
  private readonly store: TokenStore;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  readonly presencePath: string;

  constructor(o: ClientOptions) {
    if (!o.accountId || !o.queueId) throw new Error("accountId and queueId are required — refusing to guess which queue to write");
    this.o = o;
    this.store = o.tokenStore ?? new MemoryTokenStore();
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.presencePath = `/restapi/v1.0/account/${o.accountId}/call-queues/${o.queueId}/presence`;
  }

  private get protectedIds(): Set<string> { return new Set(this.o.protectedMemberIds ?? []); }
  private get protectedExts(): Set<string> { return new Set(this.o.protectedExtensions ?? []); }

  /** GET/PUT with the cached bearer; one retry with a fresh token on 401. */
  private async call(method: "GET" | "PUT", what: string, payload?: unknown): Promise<any> {
    const server = serverOf(this.o.credentials);
    const go = async (fresh: boolean) => {
      const token = await getBearer(this.o.credentials, this.store, { fresh, fetchImpl: this.fetchImpl, now: this.now });
      return this.fetchImpl(`${server}${this.presencePath}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    };
    let r = await go(false);
    if (r.status === 401) r = await go(true);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`RingCentral ${what} HTTP ${r.status}: ${txt.slice(0, 240)}`);
    }
    return r.json().catch(() => ({}));
  }

  /** Current presence of every queue member. */
  async read(): Promise<Member[]> {
    return normalizeRc(await this.call("GET", "presence read"));
  }

  capture(members: Member[]): Captured {
    return members.map((m) => ({ id: m.id, ext: m.ext, name: m.name, acceptCurrentQueueCalls: m.acceptCurrentQueueCalls, protected: isProtected(m, this.protectedIds, this.protectedExts) }));
  }

  /** The plan for a holder against the live queue, without writing. */
  async plan(holder: Holder): Promise<{ plan: Plan; before: Member[] }> {
    const before = await this.read();
    return { plan: planPresence(before, holder, this.protectedIds, this.protectedExts), before };
  }

  private async verifiedWrite(rows: PlanRow[], what: string): Promise<Member[]> {
    await this.call("PUT", `${what} write`, toRecords(rows));
    const after = await this.read();
    const ok = rows.every((r) => after.find((m) => m.id === r.id)?.acceptCurrentQueueCalls === r.after);
    // The read-back is the only thing that knows the queue is not what we intended. A green
    // result hiding a wrong on-call phone is the failure nobody goes looking for, so this throws.
    if (!ok) throw new Error(`RingCentral did not apply the ${what}: ${unconfirmed(rows, after)}`);
    return after;
  }

  /**
   * Make exactly `holder` the enabled member. Nothing is written when: the switch is off
   * (dry run), dryRun is requested, the queue already matches, the holder is not a
   * writable member, or the holder is protected. Every outcome says why.
   */
  async apply(holder: Holder, opts: { dryRun?: boolean } = {}): Promise<ApplyResult> {
    const { plan, before } = await this.plan(holder);
    const snapshot = this.capture(before);
    const base = { holder, holder_in_queue: plan.holder_in_queue, holder_protected: plan.holder_protected, before: snapshot, protected: plan.protected, after: null as Member[] | null };
    if (!plan.holder_in_queue) {
      // Nothing is written in either case, so the queue still points at whoever it pointed at
      // before. Turning the rest of the queue off would leave a protected member's own setting
      // as the only thing answering, which is a louder failure than a stale but staffed queue.
      const who = `${holder.name ?? holder.id ?? "the holder"}${holder.ext ? ` (x${holder.ext})` : ""}`;
      return { ...base, written: false, dry_run: false, changes: [], sent: [],
        why: plan.holder_protected
          ? `${who} holds the shift but is a protected member, so the client will not touch their presence — nothing written. Reassign to a rotation member or move the queue by hand.`
          : `${who} is not a member of the queue — nothing written` };
    }
    if (!plan.changes.length) return { ...base, written: false, dry_run: false, why: "queue already matches: exactly the holder is enabled", changes: [], sent: [] };
    if (opts.dryRun || !this.o.writeEnabled) {
      return { ...base, written: false, dry_run: true, why: opts.dryRun ? "dry run requested" : "writes are disabled (writeEnabled is not true) — computed only, nothing sent", changes: plan.changes, sent: plan.rows };
    }
    const after = await this.verifiedWrite(plan.rows, "presence");
    return { ...base, written: true, dry_run: false, why: null, changes: plan.changes, sent: plan.rows, after };
  }

  /** Put the queue back exactly as a captured `before` had it. Recomputes nothing. */
  async restore(snapshot: Snapshot, opts: { dryRun?: boolean } = {}): Promise<RestoreResult> {
    const before = await this.read();
    const plan = restorePlan(snapshot, before, this.protectedIds, this.protectedExts);
    const captured = this.capture(before);
    if (!plan.changes.length) return { written: false, dry_run: false, why: "the queue already matches that snapshot", before: captured, changes: [], sent: [], after: null };
    if (opts.dryRun || !this.o.writeEnabled) {
      return { written: false, dry_run: true, why: opts.dryRun ? "dry run requested" : "writes are disabled (writeEnabled is not true) — computed only, nothing sent", before: captured, changes: plan.changes, sent: plan.rows, after: null };
    }
    const after = await this.verifiedWrite(plan.rows, "presence restore");
    return { written: true, dry_run: false, why: null, before: captured, changes: plan.changes, sent: plan.rows, after };
  }
}
