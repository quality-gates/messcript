# Evidence — LackOfCohesionOfMethods ignores no-substitution template literals in element-access receivers

messcript 0.1.13 at `7eee809`. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-exploratory-2026-09-26/lcom4`.

## Issue

[#240](https://github.com/quality-gates/messcript/issues/240)

## Expectation

`docs/rules.md` defines `LackOfCohesionOfMethods`:
"Flags classes whose methods form more than maximum disconnected groups (LCOM4) via shared instance state and receiver calls."

When `methodA` calls `this[`methodB`]()` or methods access a shared instance field via `this[`shared`]`, the methods are connected. In a class where each method accesses an instance field and one calls the other (or both access the same shared field), LCOM4 is 1 (cohesive).

## Fixtures

### Cohesive fixture with template literal method call: `cohesive-template-call.ts`

```ts
class ConnectedService {
  fieldA = 1;
  fieldB = 2;

  methodA() {
    const x = this.fieldA;
    this[`methodB`]();
    return x;
  }

  methodB() {
    const y = this.fieldB;
    return y;
  }
}
```

### Cohesive fixture with template literal shared field access: `cohesive-template-field.ts`

```ts
class SharedStateService {
  shared = 1;
  fieldA = 2;
  fieldB = 3;

  methodA() {
    return this.fieldA + this[`shared`];
  }

  methodB() {
    return this.fieldB + this.shared;
  }
}
```

### Control fixture with standard string literals: `cohesive-string-literals.ts`

```ts
class ConnectedService {
  fieldA = 1;
  fieldB = 2;

  methodA() {
    const x = this.fieldA;
    this["methodB"]();
    return x;
  }

  methodB() {
    const y = this.fieldB;
    return y;
  }
}
```

## Observations

### Control run (`this["methodB"]()`)

```console
$ node dist/cli.js cohesive-string-literals.ts text design
EXIT=0
```
No findings reported. LCOM4 correctly measures 1 component.

### Test run with template literal method call (`this[`methodB`]()`) — three identical runs

```console
$ node dist/cli.js cohesive-template-call.ts text design
cohesive-template-call.ts:1:1: LackOfCohesionOfMethods [priority 3] The class ConnectedService has a Lack of Cohesion Of Methods (LCOM4) value of 2. Consider to split this class into 2 smaller classes. (context: class ConnectedService)
EXIT=2
```

### Test run with template literal shared field access (`this[`shared`]`)

```console
$ node dist/cli.js cohesive-template-field.ts text design
cohesive-template-field.ts:1:1: LackOfCohesionOfMethods [priority 3] The class SharedStateService has a Lack of Cohesion Of Methods (LCOM4) value of 2. Consider to split this class into 2 smaller classes. (context: class SharedStateService)
EXIT=2
```

## Root cause

In `src/metrics/cohesion.ts:89-95`:

```ts
function literalMemberName(node: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}
```

`literalMemberName` checks `ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)`, but omits `ts.isNoSubstitutionTemplateLiteral(expression)`. In `directReceiverMember` (line 117):

```ts
const name = expression.argumentExpression && literalMemberName(expression.argumentExpression, sourceFile);
```

When `expression.argumentExpression` is a `NoSubstitutionTemplateLiteral`, `literalMemberName` returns `undefined`, so `directReceiverMember` returns `undefined` and neither the receiver method call nor the field access is registered in the LCOM4 graph.
