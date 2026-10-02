// Pure presence arithmetic: no I/O, no clock. Everything here is unit-tested in
// tests/presence.test.ts and is the part of the client worth reading first.

/** One queue member as RingCentral returns it from GET .../call-queues/{id}/presence. */
export type Member = {
  id: string | null;
  name: string;
  ext: string;
  /** Extension-level: does this extension accept queue calls AT ALL. */
  acceptQueueCalls: boolean | null;
  /** Queue-level: is this member enabled for THIS queue. The value a cutover toggles. */
  acceptCurrentQueueCalls: boolean | null;
};

/** Who should be the single enabled member. Matched on member id first, then extension. */
export type Holder = { name?: string | null; ext?: string | null; id?: string | null };

/** One member in a write: what RingCentral had, what we intend. */
export type PlanRow = { id: string; ext: string; name: string; before: boolean | null; after: boolean };

export type Plan = {
  /** Every non-protected member with an id, holder true and everyone else false. */
  rows: PlanRow[];
  /** The subset of rows whose value differs from what the queue holds now. */
  changes: PlanRow[];
  /** The holder is a writable member of the queue. */
  holder_in_queue: boolean;
  /** The holder IS in the queue but is protected, so the plan refuses to touch them. */
  holder_protected: boolean;
  /** Members left out of the plan on purpose, with their current state, for the record. */
  protected: { id: string | null; ext: string; name: string; acceptCurrentQueueCalls: boolean | null }[];
};

/**
 * Parse the presence response defensively. A missing flag is null, never false:
 * "unknown" and "refuses calls" are different findings and must not be confused.
 * Verified shape: { records: [{ member: { id, extensionNumber, name }, acceptQueueCalls, acceptCurrentQueueCalls }] }
 */
export function normalizeRc(body: unknown): Member[] {
  const b = body as any;
  const recs: any[] = Array.isArray(b?.records) ? b.records : Array.isArray(b) ? b : [];
  return recs.map((r) => {
    const m = r?.member ?? r?.extension ?? {};
    return {
      id: m?.id != null ? String(m.id) : null,
      name: String(m?.name ?? "").trim(),
      ext: String(m?.extensionNumber ?? m?.extension_number ?? m?.extension?.extensionNumber ?? "").trim(),
      acceptQueueCalls: typeof r?.acceptQueueCalls === "boolean" ? r.acceptQueueCalls : null,
      acceptCurrentQueueCalls: typeof r?.acceptCurrentQueueCalls === "boolean" ? r.acceptCurrentQueueCalls : null,
    };
  });
}

/** A member is protected when its id or extension is in the protected sets. Protected members are never written, in either direction. */
export const isProtected = (m: Member, ids: Set<string>, exts: Set<string>): boolean =>
  (!!m.id && ids.has(m.id)) || (!!m.ext && exts.has(m.ext));

const isHolder = (m: Member, h: Holder): boolean =>
  (!!m.id && !!h.id && m.id === h.id) || (!!h.ext && m.ext === h.ext);

/**
 * The plan sends EVERY non-protected member explicitly, both directions. The write is a
 * partial update: a member left out of the payload keeps whatever state it had, so the
 * only way to guarantee "exactly one member enabled" is to state every member's value.
 */
export function planPresence(members: Member[], holder: Holder, protectedIds: Set<string>, protectedExts: Set<string>): Plan {
  const skipped = members.filter((m) => isProtected(m, protectedIds, protectedExts) || !m.id);
  const rows: PlanRow[] = members
    .filter((m) => !isProtected(m, protectedIds, protectedExts) && !!m.id)
    .map((m) => ({ id: m.id!, ext: m.ext, name: m.name, before: m.acceptCurrentQueueCalls, after: isHolder(m, holder) }));
  const holder_in_queue = rows.some((r) => r.after);
  // A protected holder is a queue member we refuse to write; a holder who is simply absent
  // is a different fault with a different fix. Both leave holder_in_queue false, so the
  // caller needs the second flag to report the right problem.
  const holder_protected = skipped.some((m) => isHolder(m, holder));
  const changes = rows.filter((r) => r.before !== r.after);
  return {
    rows,
    changes,
    holder_in_queue,
    holder_protected,
    protected: skipped.map((m) => ({ id: m.id, ext: m.ext, name: m.name, acceptCurrentQueueCalls: m.acceptCurrentQueueCalls })),
  };
}

export type Snapshot = { id: string | null; ext: string; acceptCurrentQueueCalls: boolean | null }[];

/**
 * Replay a captured snapshot verbatim. Each non-protected member present in the snapshot
 * AND in the queue now gets exactly the value it had. Nothing is recomputed.
 */
export function restorePlan(snapshot: Snapshot, members: Member[], protectedIds: Set<string>, protectedExts: Set<string>): { rows: PlanRow[]; changes: PlanRow[] } {
  const rows: PlanRow[] = [];
  for (const m of members) {
    if (isProtected(m, protectedIds, protectedExts) || !m.id) continue;
    const s = snapshot.find((x) => x.id === m.id);
    if (!s || typeof s.acceptCurrentQueueCalls !== "boolean") continue;
    rows.push({ id: m.id, ext: m.ext, name: m.name, before: m.acceptCurrentQueueCalls, after: s.acceptCurrentQueueCalls });
  }
  return { rows, changes: rows.filter((r) => r.before !== r.after) };
}

/** Which planned rows the read-back did not confirm. The text of the error when a write does not take. */
export const unconfirmed = (rows: PlanRow[], after: Member[]): string =>
  rows
    .filter((r) => after.find((m) => m.id === r.id)?.acceptCurrentQueueCalls !== r.after)
    .map((r) => `${r.name || r.id} (x${r.ext}) wanted ${r.after}`)
    .join(", ") || "no row disagreed, but the read-back was incomplete";

/** The PUT body: one record per planned row. */
export const toRecords = (rows: PlanRow[]) => ({ records: rows.map((r) => ({ member: { id: r.id }, acceptCurrentQueueCalls: r.after })) });

/**
 * The write switch. Exact string "true" only: "yes", "1", "TRUE " with a stray space and an
 * absent variable are all OFF. A switch that arms a live phone queue does not get to be
 * generous about what counts as on.
 */
export const flagIsOn = (raw: unknown): boolean => String(raw ?? "").trim().toLowerCase() === "true";
