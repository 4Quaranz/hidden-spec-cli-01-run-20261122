# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/4Quaranz/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/4Quaranz/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files, in any of the four formats models write: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, and it changes every file or none at all.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, detected from the patch).
- `--check`: do everything but write — same output and exit code, no file created, changed or deleted.
- `--strict`: match lines exactly (tier 0 only).
- `PATCH`: the patch file, relative to the working directory; absent or `-` reads it from standard input.

Node 22, standard library alone, nothing installed, deterministic: the same check gives the same exit code, stdout and files every run.

## Matching

Old lines are found at the first of three tiers at which they occur at least once: exact, trailing whitespace ignored, leading and trailing whitespace ignored. At the third tier, new lines are re-indented to the file's own indentation, and context lines are always written as the file's own matched lines. Unified hunks take the occurrence nearest the (possibly wrong) line number; SEARCH/REPLACE blocks need exactly one occurrence; V4A chunks follow an anchor and a cursor, and can pin a chunk to the end of the file.

## Exit codes

- `0`: the tree is written — one `A`/`D`/`M`/`R` line per changed path, then `ok: <n> files`.
- `1`: some edits failed — one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`; no file is written.
- `2`: usage, unreadable patch, undetected format, or unparsable patch — one `error: ...` line, nothing written.

## Practice checks

The kit's public practice set (100 checks) runs locally with:

```sh
node check.ts ../program/generator/practice.json
```

<sub>Entered on [make.fun](https://make.fun/?ref=scveefga&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
