# Evidence — DuplicatedArrayKey fails to recognize duplicate keys asserting TypeScript satisfies operator

messcript 0.1.13 at `7eee809`. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-exploratory-2026-09-26/dup-key`.

## Issue

[#241](https://github.com/quality-gates/messcript/issues/241)

## Expectation

`docs/rules.md` defines `DuplicatedArrayKey`:
"Flags repeated statically known keys in an object literal (the shared rule name still says Array). Dynamic keys are not guessed."

When an object literal defines duplicate keys using computed property names that assert types with TypeScript 4.9+ `satisfies` expressions (e.g. `[("endpoint" satisfies string)]` alongside `endpoint`), the static key value is known and should trigger `DuplicatedArrayKey`.

## Fixtures

### Test fixture with satisfies expression: `dup-satisfies.ts`

```ts
export const config = {
  [("endpoint" satisfies string)]: "https://api.example.com/v1",
  endpoint: "https://api.example.com/v2",
};
```

### Control fixture with as expression: `dup-as.ts`

```ts
export const config = {
  [("endpoint" as string)]: "https://api.example.com/v1",
  endpoint: "https://api.example.com/v2",
};
```

### Control fixture with literal key: `dup-literal.ts`

```ts
export const config = {
  endpoint: "https://api.example.com/v1",
  endpoint: "https://api.example.com/v2",
};
```

## Observations

### Control run with `as string`

```console
$ node dist/cli.js dup-as.ts text cleancode
dup-as.ts:3:3: DuplicatedArrayKey [priority 2] Duplicated array key endpoint, first declared at line 2. (context: object literal)
EXIT=2
```

### Control run with literal duplicate

```console
$ node dist/cli.js dup-literal.ts text cleancode
dup-literal.ts:3:3: DuplicatedArrayKey [priority 2] Duplicated array key endpoint, first declared at line 2. (context: object literal)
EXIT=2
```

### Test run with `satisfies string` — three identical runs

```console
$ node dist/cli.js dup-satisfies.ts text cleancode
EXIT=0
```
No findings reported.

### Additional type assertions with satisfies

```ts
const numeric = { [(42 satisfies number)]: "a", "42": "b" };
const boolean = { [(true satisfies boolean)]: "a", "true": "b" };
const nullKey = { [(null satisfies null)]: "a", "null": "b" };
```
All exit 0 with 0 findings under `cleancode`.

## Root cause

In `src/rules/duplicated-array-key.ts:15-23`:

```ts
function staticExpressionKey(node: ts.Expression): string | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return staticExpressionKey(node.expression);
  }
```

`staticExpressionKey` unwraps parenthesized expressions, `as` expressions, type assertions, and non-null expressions, but does not unwrap `ts.isSatisfiesExpression(node)`. As a result, `staticExpressionKey` returns `undefined` for computed property keys wrapped in `satisfies`.
