## What this changes

<!-- One paragraph. If it changes what is sent to RingCentral or how the read-back judges success, say so explicitly. -->

## Gate

- [ ] `npm run typecheck` is clean
- [ ] `npm test` passes, and a behaviour change comes with a test that would have failed before it
- [ ] Writes still require `RC_WRITE_ENABLED` exactly `true`; protected members are still never in a payload; the read-back still throws on an unconfirmed row
- [ ] No account, queue or member id, extension, phone number, name or credential in code, tests, fixtures or docs
- [ ] README updated where behaviour or configuration changed; the four documented RingCentral behaviours still match the code
- [ ] Every commit is signed and shows "Good signature"

## How it was verified

<!-- Commands run and their output, or the test names that cover it. -->
