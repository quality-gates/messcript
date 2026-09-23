# Evidence — LackOfCohesionOfMethods ignores non-null and satisfies asserted receivers

messcript 0.1.11 at `957904c`. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-exploratory-2026-09-23/lcom4`.

## Issue

[#215](https://github.com/quality-gates/messcript/issues/215)

## Expectation

`docs/rules.md` defines `LackOfCohesionOfMethods`:
"Flags classes whose methods form more than maximum disconnected groups (LCOM4) via shared instance state and receiver calls."

When `methodA` calls `this!.methodB()` or `(this satisfies T).methodB()`, the two methods are connected by a receiver call edge. In a class with two methods where each touches an instance field and one calls the other, LCOM4 is 1 (cohesive).

## Fixtures

### Cohesive fixture with non-null assertion: `cohesive-nonnull.ts`

```ts
class ConnectedService {
  fieldA = 1;
  fieldB = 2;

  methodA() {
    const x = this.fieldA;
    this!.methodB();
    return x;
  }

  methodB() {
    const y = this.fieldB;
    return y;
  }
}
```

### Cohesive fixture with satisfies expression: `cohesive-satisfies.ts`

```ts
class ConnectedService {
  fieldA = 1;
  fieldB = 2;

  methodA() {
    const x = this.fieldA;
    (this satisfies ConnectedService).methodB();
    return x;
  }

  methodB() {
    const y = this.fieldB;
    return y;
  }
}
```

### Control fixture without assertions: `cohesive-normal.ts`

```ts
class ConnectedService {
  fieldA = 1;
  fieldB = 2;

  methodA() {
    const x = this.fieldA;
    this.methodB();
    return x;
  }

  methodB() {
    const y = this.fieldB;
    return y;
  }
}
```

## Observations

### Control run (`this.methodB()`)

```console
$ node dist/cli.js cohesive-normal.ts text design
EXIT=0
```
No findings reported. LCOM4 correctly measures 1 component.

### Test runs with non-null assertion (`this!.methodB()`) — three identical runs

```console
$ node dist/cli.js cohesive-nonnull.ts text design
cohesive-nonnull.ts:1:1: LackOfCohesionOfMethods [priority 3] The class ConnectedService has a Lack of Cohesion Of Methods (LCOM4) value of 2. Consider to split this class into 2 smaller classes. (context: class ConnectedService)
EXIT=2
```

### Test run with satisfies expression (`(this satisfies T).methodB()`)

```console
$ node dist/cli.js cohesive-satisfies.ts text design
cohesive-satisfies.ts:1:1: LackOfCohesionOfMethods [priority 3] The class ConnectedService has a Lack of Cohesion Of Methods (LCOM4) value of 2. Consider to split this class into 2 smaller classes. (context: class ConnectedService)
EXIT=2
```

## Field access variation (false negative on disjoint class)

When a method accesses a field only via `this!.fieldA`:

```ts
class DisjointService {
  fieldA = 1;
  fieldB = 2;

  methodA() {
    const x = this!.fieldA;
    return x * 2;
  }

  methodB() {
    const y = this.fieldB;
    return y * 2;
  }
}
```

- With `this.fieldA`: LCOM4 measures 2 (reported, exit 2).
- With `this!.fieldA`: LCOM4 measures 1 (not reported, exit 0). The un-asserted field access is missed, leaving `methodA` inactive in the UnionFind graph.

## Root cause

In `src/metrics/cohesion.ts:75-81`:

```ts
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}
```

`unwrapExpression` does not unwrap `ts.isNonNullExpression(current)` or `ts.isSatisfiesExpression(current)`.
In `directReceiverMember` (lines 98 and 115):

```ts
const receiver = unwrapExpression(expression.expression);
if (isThisExpression(receiver)) { ... }
```

The receiver is a `NonNullExpression` or `SatisfiesExpression`, so `isThisExpression` evaluates to `false` and the receiver call / field access is missed.
