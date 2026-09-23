# Evidence — BooleanGetMethodName misses private fields and wrapped this receivers

messcript 0.1.11 at `957904c`. Node v26.7.0, macOS. Isolated fixture under `/tmp/mx-exploratory-2026-09-23/boolean`.

## Issue

[#216](https://github.com/quality-gates/messcript/issues/216)

## Expectation

`docs/rules.md` specifies `BooleanGetMethodName`:
"Flags proven-boolean methods that still use a `get` prefix instead of `is` / `has`."
And lines 13-16 state:
"Short callback/index/error names, React components and hooks, underscore-prefixed intentional unused parameters, destructuring, private identifiers, computed names that cannot be known statically, and ordinary module/import/type-only structure are handled with ordinary JavaScript and TypeScript expectations."

When a method `getValid()` returns `this.#isValid`, where `#isValid = true` or `#isValid: boolean` is declared on the class, the return type is statically proven to be boolean. It should be flagged.

## Fixture 1: Private field `private-field.ts`

```ts
class Validator {
  #isValid = true;

  getValid() {
    return this.#isValid;
  }
}
```

## Fixture 2: Non-null asserted `this` `nonnull-this.ts`

```ts
class Validator {
  isValid = true;

  getValid() {
    return this!.isValid;
  }
}
```

## Control fixture: Public field `public-field.ts`

```ts
class Validator {
  isValid = true;

  getValid() {
    return this.isValid;
  }
}
```

## Observations

### Control run (`public-field.ts`)

```console
$ node dist/cli.js public-field.ts text naming
public-field.ts:4:3: BooleanGetMethodName [priority 4] The 'getValid()' method which returns a boolean should be named 'is...()' or 'has...()' (context: method getValid())
EXIT=2
```

### Test run with private field (`private-field.ts`) — three identical runs

```console
$ node dist/cli.js private-field.ts text naming
EXIT=0
```
No findings reported.

### Test run with typed private field (`#isValid: boolean = true`)

```console
$ node dist/cli.js private-typed.ts text naming
EXIT=0
```
No findings reported.

### Test run with non-null asserted this (`nonnull-this.ts`)

```console
$ node dist/cli.js nonnull-this.ts text naming
EXIT=0
```
No findings reported.

### Test run with parenthesized this (`(this).isValid`)

```console
$ node dist/cli.js paren-this.ts text naming
EXIT=0
```
No findings reported.

## Root cause

In `src/metrics/boolean.ts`:

1. `resolveThisProperty` (line 70):
```ts
for (const member of parent.members) {
  if (
    ts.isPropertyDeclaration(member) &&
    member.name &&
    ts.isIdentifier(member.name) &&
    member.name.text === propName
  ) {
```
For a private field, `member.name` is a `ts.PrivateIdentifier`. `ts.isIdentifier(member.name)` evaluates to `false`.

2. `getThisPropertyName` (lines 40 and 45):
```ts
if (ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
  return expression.name.text;
}
```
`expression.expression` is tested directly against `SyntaxKind.ThisKeyword` without unwrapping parenthesized or non-null asserted expressions.
