# Zone gate corrective investigation

Execution 10250's complete logs were not supplied. Its reported bot shutdown
symptom was reproduced locally against the linked relay on 2026-10-30:
two bots waiting in an eight-peer queue returned `[1, 1]` after `stop()`.
The first causal mechanism in that reproduction is SIGTERM: zoneLaunch sends it,
zoneBot had no handler, and the launcher's `code ?? 1` converts a signal exit
(null code) to 1. These cleanup messages alone do not establish the earlier
GPU gate's first failure; the gate previously only printed them.

The bot now handles SIGTERM and SIGINT before asynchronous initialization.
Cancellation closes a connecting/queued socket, rejects startup with the abort
reason, or stops an active match. Only that requested cancellation returns zero;
other startup failures and forced kills remain failures. The launcher records
stdout/stderr and explicit exit code, signal, and requested-stop state. The gate
fails on nonzero bot exits and saves redacted gate/bot/relay logs under out/m6.
Bots start after page preparation, immediately before the two browser jobs.

The earlier exposure repair is retained: NMC_EXPOSE_URL is the only supported
route, and addresses are registered before publishing pages. The reachability
probe distinguishes connect-src policy, SecurityError, socket failure, and
timeout. There is no alternate transport or Linux Chrome fallback. No new
nomorechat host fault has been established by this model-card run.

## Local functional results

- Before fix, queued shutdown: `[1, 1]`.
- After fix, two matched peers playing for one second: `[0, 0]`.
- Two matched peers explicitly stopped during play: `[0, 0]`.
- Six peers queued for eight, explicitly stopped: `[0, 0, 0, 0, 0, 0]`.
- Invalid course startup: `[1]`, with the original refusal preserved.
- Raw local reproduction logs: out/m6/zone-local-bots.log and
  out/m6/zone-local-relay.log (scratch evidence, not public artifacts).
- zoneBot and zoneGateRelay targeted tests: 4 passed, 0 failed. These cover
  movement, queue tuning, pending-queue cancellation, and exposure requests.
- npm run typecheck: passed.
- npm run build: passed using the repository's configLoader runner script.
- git diff --check: passed.

## Programmatic verification

The five entries in .nmc/commands.json are written unchanged for card 6129:
zone-gate-build, zone-gate-typecheck, zone-gate-chrome, zone-gate-judge-a,
zone-gate-judge-b. Their dependency chain, six bots plus exactly two Chrome
players, course, capture assertions, judge description, and score 6 remain intact.
Both PNGs and the three redacted diagnostic logs are listed as artifacts.

The full gate was not launched here: model cards cannot run GPU jobs, and the
follow-up programmatic card owns these commands. The local bot checks above do
not substitute for Chrome captures. GPU reachability, the two captures, and both
judge scores remain unverified until card 6129 runs. If that run fails, inspect
zone-gate.log first, then zone-bots.log and zone-relay.log; signal cleanup no
longer hides the distinction between requested shutdown and a real bot error.
