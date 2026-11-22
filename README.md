[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/andsfx/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/andsfx/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` applies AI-written edits to a tree of text files and reads all four formats models actually emit: unified diffs with drifted line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls. It finds the lines an edit names through three matching tiers, and it writes every file or none.

Built for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

## Behaviour

- `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, patch read from `PATCH` or standard input.
- Exit codes, stdout lines and file results follow SPEC.md exactly, including every usage, parse and match error.
- `--check` reports without writing; `--strict` restricts matching to exact lines.
- All-or-nothing: a run that cannot apply every edit leaves the tree untouched.

## Local result

300 of 300 practice checks pass (unified 90/90, search_replace 60/60, v4a 60/60, json 45/45, cli 45/45), and the kit grader reports score 1000 with 100/100 checks on the dev trial.

`runner.ts` and `check.ts` are the kit's harness files, unmodified.
