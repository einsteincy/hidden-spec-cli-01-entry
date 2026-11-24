[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/einsteincy/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/einsteincy/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files, in four
formats, to the specification in `SPEC.md` (v1): a unified diff (often
with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. Every file is changed or nothing is.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`. It implements all of SPEC.md:
  invocation and usage errors, output and exit codes 0/1/2, safe paths,
  format detection, three-tier line matching (exact, trailing-trim,
  fully-trim with re-indentation), unified diffs, SEARCH/REPLACE blocks,
  V4A patches, JSON edits, and all-or-nothing writes. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the
  env, runs `node main.ts` on each one in a fresh directory, and posts
  what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification (v1). It is the whole contract.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the
files it starts with. It passes when the exit code, everything written to
stdout and every file afterwards are exactly what SPEC.md says. Standard
error is never compared. Each run has 10 seconds; the whole trial of 100
checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line
numbers, drifted whitespace and indentation, blank context lines without
their leading space, prose and code fences around the patch, CRLF files,
files without a final line break, blocks that occur twice. Read SPEC.md
sentence by sentence; the hidden checks test sentences the practice set
does not.
