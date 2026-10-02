# ringcentral-queue-presence

A small client that makes exactly one member of a RingCentral call queue the enabled one,
and proves it did. Extracted from an on-call rotation that writes queue presence once a day
and after every roster change; the rotation half lives in
[msp-automation/windmill/rotation-scheduler](https://github.com/AlrightLad/msp-automation/tree/main/windmill/rotation-scheduler).

The value here is the documented behavior. The RingCentral presence API has four properties
that are easy to get wrong and expensive to discover live.

## The four things to know

### 1. Omitted members keep their state, so every member is written explicitly

`PUT /restapi/v1.0/account/{account}/call-queues/{queue}/presence` takes a `records` array.
It reads like a partial update, and in this client's experience it behaves like one: a member
left out of the payload keeps whatever `acceptCurrentQueueCalls` it already had. That is the
wrong default for a cutover, because "make the new on-call the enabled member" silently
becomes "make two people enabled". The only way to guarantee exactly one enabled member is to
state every writable member's value, both directions, on every write. `planPresence()` does
that: holder `true`, every other non-protected member `false`, no member omitted. The plan
also lists `changes` separately so a log can show what actually moved.

If your tenant behaves as a full replace instead, this client is still correct: a full member
list is the right payload under either semantics. Do not shorten it.

### 2. Writing presence needs the `EditPresence` permission

The app credential (JWT grant preferred; password grant supported) must carry
`EditPresence` to write. The read-only drift check in the rotation scheduler runs under the
same credential; the source notes the JWT's scope includes `EditPresence` even though that
code only reads.

### 3. The extension-level flag can silently override the queue-level one

Each presence record carries two booleans:

| Field | Level | Meaning |
|---|---|---|
| `acceptCurrentQueueCalls` | queue | this member is enabled for **this** queue. The value a cutover toggles. |
| `acceptQueueCalls` | extension | the extension accepts queue calls **at all** |

A member enabled for the queue whose extension refuses queue calls is marked on-call and
receives nothing. Nothing in the presence write fails; the phone just does not ring. This
client surfaces `acceptQueueCalls` on every member (`null` when the API did not return it,
never `false`) so a caller can treat `enabled + refuses` as the silent coverage failure it is.
The rotation scheduler's drift check reports exactly that case as `bad`.

### 4. Cache the bearer; the mint rate limit is low

RingCentral allows only a handful of token mints per minute per application. In production
this showed up as HTTP 429 with `x-rate-limit-remaining: 0` after a few back-to-back runs
that each minted their own token, which took a read-only dashboard check to "unknown" for
everyone looking at it. A bearer is valid for about an hour. `getBearer()` keeps one token in
a `TokenStore` (in-process by default; implement the two-method interface to share it across
processes), re-mints two minutes before expiry, and once more on a 401. Three calls, one mint.

## Safety model

- **No default account or queue.** Both ids are required. A lab or a fork carrying real
  credentials must never write a production queue because half its configuration was copied.
- **Writes are off until `RC_WRITE_ENABLED` is exactly `true`.** Anything else, including a
  missing variable, makes every `apply()` a dry run: computed, reported, nothing sent.
- **Protected members are never written, in either direction.** A standing escalation
  extension that stays in the queue but is not part of the rotation goes in
  `RC_PROTECTED_MEMBER_IDS` or `RC_PROTECTED_EXTENSIONS`. If the computed holder is a
  protected member, nothing is written and the result says so, distinctly from "the holder is
  not in the queue".
- **Idempotent.** A queue that already matches is left alone.
- **Read-back verification.** After a write the queue is read again. Any row the read-back does
  not confirm throws, naming the member and the value it wanted. A write the API accepted but
  did not apply must not exit green.
- **Restore.** Every result carries the `before` capture. `restore()` replays one verbatim,
  recomputing nothing.

## Use

```bash
cp .env.example .env     # fill in; never commit .env
npm ci
npm test

node src/cli.ts show                                   # current presence, protected members marked
node src/cli.ts plan  --holder-ext 1001                # what would be sent
node src/cli.ts apply --holder-ext 1001 --dry-run      # same, through the full path
RC_WRITE_ENABLED=true node src/cli.ts apply --holder-ext 1001
node src/cli.ts restore --snapshot before.json --dry-run
```

As a library:

```ts
import { QueuePresenceClient } from "./src/client.ts";
const client = new QueuePresenceClient({ credentials, accountId, queueId, protectedExtensions: ["1006"], writeEnabled: true });
const result = await client.apply({ ext: "1001" });   // result.before, result.sent, result.after, result.changes
```

Requires Node 22.18 or later (TypeScript is run directly through Node's type stripping; no build step).

## What this is not

It is not a scheduler and does not decide who is on call. Give it a holder; it makes the queue
agree and tells you what it changed. It also does not audit to a database: every method returns
the before/sent/after record so the caller can store it wherever audit records live.

## License

[MIT](LICENSE)
