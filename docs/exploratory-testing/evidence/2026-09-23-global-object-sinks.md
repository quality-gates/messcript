# Evidence — sinks reached through the global object are reported as reads

messcript 0.1.10 at `5d0c881`, plus the uncommitted `feat/explicitness-ruleset`
changes. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-expl/bug1`.

## Expectation

`docs/rules.md` says `ImplicitOutput` covers "use of sinks (`console`, `fetch`,
`alert`, timers)". `window.alert()` and `globalThis.setTimeout()` call the same
sinks as `alert()` and `setTimeout()`.

## Minimal fixture `m.js`

```js
function f() { window.alert(); }
```

## Runs before the fix (three identical runs)

```console
$ node dist/cli.js m.js text explicitness
m.js:1:16: ImplicitInput [priority 3] The function f() reads window, an implicit input. (context: function f())
```

There is no `ImplicitOutput` finding.

## Controls

| Source | Before the fix |
|---|---|
| `alert();` | `ImplicitOutput uses alert` |
| `window.alert();` | `ImplicitInput reads window` |
| `globalThis.setTimeout();` | `ImplicitInput reads globalThis` |
| `self.fetch();` | `ImplicitInput reads self` |
| `window.console.log();` | `ImplicitInput reads window` |
| `window.foo();` | `ImplicitInput reads window` (correct) |
| `window.localStorage.setItem();` | `ImplicitOutput writes window` (correct) |

## Diagnosis

A tagged probe in `ambientFlow` showed that it received only the `window`
identifier. `alert` is a property name, so `isValueReference` excludes it and
the `outputSinks` check never sees it. The `hostObjects` check then classifies
`window` as a read. No output flow was produced, so the per-function dedupe was
not involved.

## Fix and verification

`ambientFlow` now resolves `window.x`, `globalThis.x`, and `self.x` to `x` before
the sink check (`sinkName` in `src/analysis/explicitness.ts`). The regression test
"a sink reached through the global object is an output, not a read of the global
object" in `test/explicitness.test.mjs` failed before the fix and passes after it.

```console
$ node dist/cli.js a.js text explicitness
a.js:1:34: ImplicitOutput [priority 3] The function alertUser() uses alert, an implicit output. (context: function alertUser())
a.js:2:27: ImplicitInput [priority 3] The function go() reads window, an implicit input. (context: function go())
a.js:3:29: ImplicitOutput [priority 3] The function later() uses setTimeout, an implicit output. (context: function later())
a.js:4:26: ImplicitInput [priority 3] The function stop() reads process, an implicit input. (context: function stop())
```

Lines 2 and 4 are the separate unresolved candidate U1 in the report.
