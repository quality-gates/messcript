# Evidence — ImplicitOutput misses sinks reached via element access and parenthesized globals

messcript 0.1.11 at `957904c`. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-exploratory-2026-09-23/explicitness`.

## Issue

[#217](https://github.com/quality-gates/messcript/issues/217)

## Expectation

`docs/rules.md` specifies `ImplicitOutput`:
"Flags data that leaves a function other than through its return value: writes to outer or module bindings, mutation of an argument (reassignment is not an output), writes to host objects, and use of sinks (`console`, `fetch`, `alert`, timers), also through `window`, `globalThis`, or `self`."

Calling `window['alert'](...)`, `globalThis['fetch'](...)`, `(window).alert(...)`, or `(globalThis).fetch(...)` invokes output sinks and should be reported as `ImplicitOutput uses <sink>`.

## Fixture `sinks.js`

```js
function f1() {
  window['alert']('hello');
}

function f2() {
  (window).alert('hello');
}

function f3() {
  globalThis['fetch']('/api');
}

function f4() {
  (globalThis).fetch('/api');
}
```

## Control fixture `controls.js`

```js
function f5() {
  window.alert('hello');
}

function f6() {
  globalThis.fetch('/api');
}
```

## Observations

### Control run (`controls.js`)

```console
$ node dist/cli.js controls.js text explicitness
controls.js:1:17: ImplicitOutput [priority 3] The function f5() uses alert, an implicit output. (context: function f5())
controls.js:5:17: ImplicitOutput [priority 3] The function f6() uses fetch, an implicit output. (context: function f6())
EXIT=2
```

### Test run (`sinks.js`) — three identical runs

```console
$ node dist/cli.js sinks.js text explicitness
sinks.js:2:3: ImplicitInput [priority 3] The function f1() reads window, an implicit input. (context: function f1())
sinks.js:6:4: ImplicitInput [priority 3] The function f2() reads window, an implicit input. (context: function f2())
sinks.js:10:3: ImplicitInput [priority 3] The function f3() reads globalThis, an implicit input. (context: function f3())
sinks.js:14:4: ImplicitInput [priority 3] The function f4() reads globalThis, an implicit input. (context: function f4())
EXIT=2
```

In every case, the output sink was missed, and the call was falsely classified as an `ImplicitInput` reading host objects.

## Nondeterministic call variation

In `nondet.js`:
```js
function d1() { return Date['now'](); }
function d2() { return (Date).now(); }
function r1() { return Math['random'](); }
function r2() { return (Math).random(); }
```
- Dot access `Date.now()` and `Math.random()` report `ImplicitInput ... calls Date.now() / Math.random()`.
- Bracket access `Date['now']()` and parenthesized `(Date).now()` produce 0 findings and exit 0.

## Root cause

In `src/analysis/explicitness.ts:299-303`:

```ts
function sinkName(node: ts.Identifier): string {
  const parent = node.parent;
  const viaGlobal = globalObjects.has(node.text) && ts.isPropertyAccessExpression(parent) && parent.expression === node;
  return viaGlobal ? parent.name.text : node.text;
}
```

1. `viaGlobal` checks only `ts.isPropertyAccessExpression(parent)`.
   - For `window['alert']`, `parent` is `ts.ElementAccessExpression`.
   - For `(window).alert()`, `node.parent` is `ts.ParenthesizedExpression`.
2. As a result, `sinkName` returns `node.text` (`"window"` or `"globalThis"`).
3. In `ambientFlow` (lines 305-315):
   - `outputSinks.has("window")` is false.
   - `hostObjects.has("window")` is true.
   - It falls into `write ? ["output", "writes window"] : ["input", "reads window"]`, misclassifying the sink call as an input read.
4. In `ambientCallDescription` (lines 287-297), only `ts.isPropertyAccessExpression(parent)` is inspected, omitting element access and parenthesized receivers.
