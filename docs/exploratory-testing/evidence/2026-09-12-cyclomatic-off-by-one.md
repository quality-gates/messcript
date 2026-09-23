# Evidence — CyclomaticComplexity never fires at its configured threshold

messcript 0.1.8, built from `34cfcdd`. Node v26.7.0. Isolated fixture.

## Fixture `cc.ts`

```ts
export function atThreshold(a: boolean[]): boolean {
  return !!(a[0] && a[1] && a[2] && a[3] && a[4] && a[5] && a[6] && a[7] && a[8] && a[9]);
}
```

Nine `&&` decision points, so the documented metric is 9 + 1 = 10 — exactly the
default `reportLevel`.

## Run 1 — default `reportLevel=10`

```console
$ node dist/cli.js cc.ts text codesize --only CyclomaticComplexity
EXIT=0
```

No output.

## Run 2 — identical repeat

```console
$ node dist/cli.js cc.ts text codesize --only CyclomaticComplexity
EXIT=0
```

## Run 3 — same file, `reportLevel=9`

```xml
<ruleset name="cc9"><rule ref="CyclomaticComplexity"><properties><property name="reportLevel" value="9"/></properties></rule></ruleset>
```

```console
$ node dist/cli.js cc.ts text cc9.xml
cc.ts:1:1: CyclomaticComplexity [priority 3] The function atThreshold() has a Cyclomatic Complexity of 10. The configured cyclomatic complexity threshold is 9. (context: function atThreshold())
EXIT=2
```

The tool measures 10. At `reportLevel=10` it stays silent; at 9 it reports.

## Sweep confirming the boundary

With `reportLevel=2` none of `if`, ternary, `&&`, `??`, `?.`, `for`, `while`,
`do`, `for..of`, `try/catch` single-decision functions were reported. With
`reportLevel=1` every one of them was reported as "Cyclomatic Complexity of 2".

## Source

`src/rules/cyclomatic-complexity.ts:32` uses `complexity > threshold`. Every
sibling "at least"/"reaches" rule uses inclusive comparison:

- `src/rules/npath-complexity.ts:26` — `complexity >= properties.minimum`
- `src/rules/excessive-method-length.ts:20` — `lineCount < properties.minimum` → return
- `src/rules/excessive-class-complexity.ts:16` — `complexity < properties.maximum` → return
- `src/rules/excessive-parameter-list.ts:17`, `excessive-public-count.ts:18`, `excessive-class-length.ts:16` — same inclusive shape
- `src/rules/coupling-between-objects.ts:228,238` — `< maximum` / `>= maximum`
