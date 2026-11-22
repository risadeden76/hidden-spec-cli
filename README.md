# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/risadeden76/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/risadeden76/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text files. It finds the lines an edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive), and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- PATCH is the path of the patch file; when absent or `-`, the patch is read from standard input.

Exit 0 prints one line per changed file (`A`/`D`/`M`, or `R old -> new` for a move) then `ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits` — nothing is written. Exit 2 is a usage, missing-patch, format-detection or parse error.

## Practice

```sh
node check.ts <path/to/practice.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ekkx10fx&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
