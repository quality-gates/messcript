# Evidence — ExitExpression / DevelopmentCodeFragment call receivers

messcript 0.1.15 at `c920402`, Node v26.7.0, macOS. Fixtures created by [2026-10-03-replay.sh](2026-10-03-replay.sh).

## Issues

- [#284](https://github.com/quality-gates/messcript/issues/284) — locally bound `exit` reported
- [#285](https://github.com/quality-gates/messcript/issues/285) — calls through `globalThis` / `window` missed

## Expectation

`docs/rules.md`: `ExitExpression` "Flags process-exit style calls such as `process.exit`"; `DevelopmentCodeFragment` flags "leftover debug calls". `ImplicitOutput` already treats sinks reached "through `window`, `globalThis`, or `self`" as the same sink.

## Replay (run 1 of 3; runs 2 and 3 byte-identical)

```text
## 3 locally bound exit
$ messcript quit.tsx text typescript,opinionated
quit.tsx:7:7: ExitExpression [priority 1] The arrow function anonymous() contains an exit expression. (context: arrow function anonymous())
exit=2

## 4 global-object receivers
$ messcript globals.ts text typescript,opinionated
exit=0

$ messcript control.ts text typescript,opinionated
control.ts:2:3: ExitExpression [priority 1] The function shutdown() contains an exit expression. (context: function shutdown())
control.ts:5:3: DevelopmentCodeFragment [priority 2] The function trace() calls the typical debug function console.log() which is mostly only used during development. (context: function trace())
exit=2
```

## Variation table (one call per file, `design --only ExitExpression`)

| Call | Reported |
|---|---|
| `process.exit(1)` | yes |
| `(process).exit(1)` | yes |
| `process!.exit(1)` | yes |
| `process["exit"](1)` | yes |
| `(process as any).exit(1)` | yes |
| `process?.exit(1)` | yes |
| `Deno.exit(1)` / `process.abort()` | yes |
| `globalThis.process.exit(1)` | **no** |
| `process.reallyExit(1)` | no (undocumented internal; not filed) |
| two exits in one function | one finding (per-scope by design) |

`DevelopmentCodeFragment` (`--only DevelopmentCodeFragment`): `console.log`, `console?.log`, `console["log"]` reported; `globalThis.console.log` and `window.console.log` **not** reported. A parameter named `console` with `console.log("x")` **is** reported (same shadowing pattern as #284).
