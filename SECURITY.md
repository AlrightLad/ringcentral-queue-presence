# Security policy

This client writes to a live telephone queue. A defect in it does not corrupt a database; it
decides whose phone rings when a customer calls an emergency line, or makes nobody's ring.
Treat a vulnerability here as an availability issue for a human-safety path, and treat the
RingCentral credential it holds (`EditPresence` scope) as a credential that can silence a
queue.

## Supported versions

Only the current `main` branch is supported. There are no release branches; a fix lands on
`main` and the commit is the fix. Pin to a commit SHA if you need reproducibility.

| Version | Supported |
|---|---|
| `main` (latest commit) | yes |
| any earlier commit | no, update to `main` |

## Reporting a vulnerability

Please report privately. Do not open a public issue for anything that could be used to alter
or disable a queue.

- Email: **zboogher@gmail.com**, subject line starting with `[ringcentral-queue-presence security]`.
- Or use GitHub's private vulnerability reporting on this repository if it is enabled
  (Security tab → Report a vulnerability).

Include what you found, how to reproduce it, the commit SHA you tested, and whether you
believe it is already being exploited.

**Response time.** Acknowledgement within 3 business days; an assessment with a planned fix or
an explanation within 14 days. Anything that can write to a queue without `RC_WRITE_ENABLED`
being exactly `true`, or that can bypass read-back verification, is treated as critical and
fixed first.

## What counts

In scope: any path that writes when the switch is off or when `dryRun` is requested; any path
that writes a protected member; a read-back that reports success when the queue does not match
the plan; credential or token leakage (including into logs or returned records); a crafted API
response that makes the plan enable more than one member or nobody.

Out of scope: RingCentral's own platform behaviour (report to RingCentral), and findings that
require control of the host that holds the credential.

## This is a sanitized reference

The client was extracted from a production on-call presence writer and re-implemented without
its orchestration platform. Account, queue and member identifiers were removed; there are no
default ids, by design, so a copy of this code with real credentials cannot write a real queue
until someone deliberately configures which one.

**Operators are responsible for reviewing it before running it against a real queue**: the
scope on the app credential, who can set `RC_WRITE_ENABLED`, which members are protected, and
how the `before` snapshots are retained so a bad write can be restored. The maintainer has no
visibility into your tenant and has not assessed this code against it.
