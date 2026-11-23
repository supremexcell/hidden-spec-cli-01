# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/supremexcell/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/supremexcell/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for the [make.fun "Build mend, one patch tool for every AI edit format" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — $100 in USDC. `mend` applies an AI-written edit to a tree of text files, all or nothing, exactly as `SPEC.md` in the kit specifies. Play it with Vicko's referral code `bj2pae9c` at [make.fun](https://make.fun).

## What it does

One CLI, four formats, one contract:

- **Unified diffs** — hunks are matched at the occurrence nearest their
  (often wrong) stated line number, so drifted diffs still apply.
- **SEARCH/REPLACE blocks** — matched at three tiers of whitespace
  tolerance, failing `ambiguous` when the old text occurs more than once.
- **V4A patches** — `*** Begin Patch` sections with an anchor-and-cursor
  walk through the file, plus add, delete and move.
- **JSON tool calls** — `create`, `str_replace` and `insert`, as one JSON
  array or as JSON Lines.

Matching is three-tiered everywhere lines are matched: exact, then
trailing whitespace ignored, then leading and trailing whitespace
ignored with the replacement re-indented to the file's own indentation.
Context lines are always written as the file's own lines, never the
patch's. CRLF files stay CRLF, files without a final line break keep
that, and `--check` reports exactly what a real run would do without
writing anything. A failed edit changes nothing, later edits still run
and are all reported, and when any edit fails no file is written.

## Measured results

| Check | Result |
| --- | --- |
| Practice set (kit, 100 checks) | **100 of 100 passed: practice score 1000** |
| Own edge-case suite (41 cases) | **41 passed, 0 failed** |

The edge suite covers wrong line numbers, overlapping hunks, moves
(`R` lines), `\ No newline at end of file`, CRLF, atomicity, unsafe
paths, `--check`, usage errors, ambiguous SEARCH/REPLACE, V4A moves
and end-of-file chunks, overlapping JSON `str_replace`, `--strict`,
and idempotent no-op patches.

## Files

- `main.ts` — the CLI (Node 22, standard library only, erasable-syntax
  TypeScript). Run as `node main.ts [options] [PATCH]`.
- `runner.ts` — the kit's trial runner, kept as it is.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the entry wallet.

## Local run

```sh
node main.ts patch.diff
node main.ts --format=search-replace --check patch.txt
printf '...' | node main.ts
```
