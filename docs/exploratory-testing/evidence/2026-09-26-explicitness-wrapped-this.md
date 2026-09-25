# Evidence — ImplicitInput and ImplicitOutput under include-this misclassify wrapped this receivers

messcript 0.1.13 at `7eee809`. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-exploratory-2026-09-26/explicitness`.

## Issue

[#242](https://github.com/quality-gates/messcript/issues/242)

## Expectation

`docs/rules.md` specifies `include-this` behavior for `ImplicitInput` and `ImplicitOutput`:
- `ImplicitInput`: "Set include-this=true to also flag this.x reads outside constructors."
- `ImplicitOutput`: "Set include-this=true to also flag this.x writes outside constructors."
- Under Explicitness overview: "include-this reports class state reads and writes, but not method calls or constructors"

Calling a method on a wrapped `this` receiver (`this!.helper()`, `(this).helper()`, `(this satisfies T).helper()`) is a method call, not a class state read, and should produce no `ImplicitInput` finding.

Writing to a wrapped instance property (`(this).state = 1`, `this!.state = 1`) should identify the property name and report `writes this.state`.

## Fixtures

### Custom policy: `strict-explicitness.xml`

```xml
<ruleset name="strict-explicitness">
  <rule ref="rulesets/explicitness.xml/ImplicitInput">
    <properties>
      <property name="include-this" value="true" />
    </properties>
  </rule>
  <rule ref="rulesets/explicitness.xml/ImplicitOutput">
    <properties>
      <property name="include-this" value="true" />
    </properties>
  </rule>
</ruleset>
```

### Wrapped this fixture: `worker-wrapped.ts`

```ts
class Worker {
  state = 0;
  helper() {}

  run() {
    this!.helper();
    (this).state = 1;
  }
}
```

### Satisfies this fixture: `worker-satisfies.ts`

```ts
class Worker {
  state = 0;
  helper() {}

  run() {
    (this satisfies Worker).helper();
    (this satisfies Worker).state = 1;
  }
}
```

### Control fixture with unwrapped this: `worker-unwrapped.ts`

```ts
class Worker {
  state = 0;
  helper() {}

  run() {
    this.helper();
    this.state = 1;
  }
}
```

## Observations

### Control run (`this.helper()` and `this.state = 1`)

```console
$ node dist/cli.js worker-unwrapped.ts text strict-explicitness.xml
worker-unwrapped.ts:7:5: ImplicitOutput [priority 3] The method run() writes this.state, an implicit output. (context: method run())
EXIT=2
```
Only the property write `this.state = 1` is reported, with its property name. `this.helper()` produces no finding.

### Test run with non-null assertion and parenthesized this (`worker-wrapped.ts`) — three identical runs

```console
$ node dist/cli.js worker-wrapped.ts text strict-explicitness.xml
worker-wrapped.ts:6:5: ImplicitInput [priority 3] The method run() reads this, an implicit input. (context: method run())
worker-wrapped.ts:7:6: ImplicitOutput [priority 3] The method run() writes this, an implicit output. (context: method run())
EXIT=2
```
- Line 6: `this!.helper()` is falsely flagged as `reads this`.
- Line 7: `(this).state = 1` reports generic `writes this` instead of `writes this.state`.

### Test run with satisfies expression (`worker-satisfies.ts`)

```console
$ node dist/cli.js worker-satisfies.ts text strict-explicitness.xml
worker-satisfies.ts:6:6: ImplicitInput [priority 3] The method run() reads this, an implicit input. (context: method run())
worker-satisfies.ts:7:6: ImplicitOutput [priority 3] The method run() writes this, an implicit output. (context: method run())
EXIT=2
```

## Root cause

In `src/analysis/explicitness.ts:387-396`:

```ts
function thisFlow(node: ts.Node, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const parent = node.parent;
  const member = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : undefined;
  const subject = member ? `this.${member.name.text}` : "this";
  if (write && !write.viaCall) {
    return ["output", `writes ${subject}`];
  }
  const methodCall = member && ts.isCallExpression(member.parent) && member.parent.expression === member;
  return methodCall ? undefined : ["input", `reads ${subject}`];
}
```

`thisFlow` tests only immediate `node.parent`. When `node` is `this`, wrapper expressions (parentheses, non-null assertions, `satisfies`, or `as` casts) sit between the `ThisKeyword` and the outer `PropertyAccessExpression`. Consequently:
- `member` evaluates to `undefined`.
- `subject` falls back to `"this"`.
- `methodCall` evaluates to `undefined`, misreporting method calls as state reads (`reads this`).
- Writes fall back to `writes this` instead of identifying the property name.
