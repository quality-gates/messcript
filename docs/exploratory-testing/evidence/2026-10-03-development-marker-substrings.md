# Evidence — DevelopmentCodeFragment matches comment markers as substrings

messcript 0.1.15 at `c920402`, Node v26.7.0, macOS. Fixtures created by [2026-10-03-replay.sh](2026-10-03-replay.sh) in a fresh `mktemp -d` directory.

## Issue

[#281](https://github.com/quality-gates/messcript/issues/281)

## Expectation

`docs/rules.md`: `DevelopmentCodeFragment` "Flags leftover debug calls ... and comment markers. Default markers: `TODO,FIXME,HACK` (case-insensitive)." A marker is a word; "Mastodon" and "shackles" contain no marker.

## Replay (run 1 of 3; runs 2 and 3 byte-identical)

```text
## 1 marker substrings
$ messcript words.ts text typescript
words.ts:1:1: DevelopmentCodeFragment [priority 2] Development-only marker found in production source. (context: module)
words.ts:3:1: DevelopmentCodeFragment [priority 2] Development-only marker found in production source. (context: module)
words.ts:5:1: DevelopmentCodeFragment [priority 2] Development-only marker found in production source. (context: module)
exit=2

```

Only line 5 has a marker. Lines 1 and 3 are false positives.

## Exploratory fixture (first observation)

`// Mastodon toot` and `// TODOS are tracked elsewhere` were both reported, alongside expected hits for `// TODO:`, `/* HACK block */`, JSDoc `todo`, JSX `{/* FIXME */}`, and a trailing `// HACK`. A template literal containing `FIXME` and a string containing `TODO` were correctly not reported.
