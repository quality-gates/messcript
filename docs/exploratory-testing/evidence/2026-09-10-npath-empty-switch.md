# NPath empty-switch evidence

Environment: messcript `0.1.6`, commit `57eaf6b`, Node `v26.7.0`.

Fixture:

```ts
export function plain() {}

export function emptySwitch(value: number) {
  switch (value) {}
}

export function switchThenBranch(value: number) {
  switch (value) {}
  if (value) return 1;
  return 0;
}

export function oneCase(value: number) {
  switch (value) {
    case 1: return 1;
  }
}
```

Ruleset:

```xml
<ruleset name="npath-one">
  <rule name="NPathComplexity">
    <priority>3</priority>
    <properties><property name="minimum" value="1"/></properties>
  </rule>
</ruleset>
```

Command:

```sh
node <messcript-repo>/dist/cli.js src/npath-edge.ts text rulesets/npath-one.xml --ignore-violations-on-exit
```

Observed twice, with identical output:

```text
src/npath-edge.ts:1:1: NPathComplexity [priority 3] The function plain() has an NPath complexity of 1. The configured NPath complexity threshold is 1. (context: function plain())
src/npath-edge.ts:13:1: NPathComplexity [priority 3] The function oneCase() has an NPath complexity of 1. The configured NPath complexity threshold is 1. (context: function oneCase())
```

`emptySwitch()` and `switchThenBranch()` are omitted. With the same fixture and a threshold of `0`, messcript reports both as NPath `0`.

Expected: an empty switch contributes one feasible path. `emptySwitch()` should therefore be NPath `1`; `switchThenBranch()` should retain the two paths from its `if`, rather than being reduced to zero. A threshold of `1` should report both functions.

Likely source: the switch branch in `src/metrics/complexity.ts` reduces clause paths from an initial value of `0`, so an empty clause list returns zero and zero then annihilates enclosing sequence products.
