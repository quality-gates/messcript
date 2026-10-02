# Evidence — React components and hooks reported by naming rules

messcript 0.1.15 at `c920402`, Node v26.7.0, macOS. Fixtures created by [2026-10-03-replay.sh](2026-10-03-replay.sh).

## Issues

- [#282](https://github.com/quality-gates/messcript/issues/282) — `CamelCaseMethodName` on function-declaration components
- [#283](https://github.com/quality-gates/messcript/issues/283) — `ConstantNamingConventions` on arrow components and hooks

## Expectation

- `docs/rules.md`: "Short callback/index/error names, React components and hooks ... are handled with ordinary JavaScript and TypeScript expectations." The `CamelCaseMethodName` row says "Conservative around private, React, hook, and similar names."
- Spec [#1](https://github.com/quality-gates/messcript/issues/1): "Naming rules understand ... React component PascalCase, hook names"; "`ConstantNamingConventions` applies only to bindings that are semantically constant ..., not every binding written with `const`"; "Idiom cases prove exclusions for ... React components, hooks".
- Both rules run under the recommended `typescript` ruleset.

## Replay (run 1 of 3; runs 2 and 3 byte-identical)

```text
## 2 React function component
$ messcript Header.tsx text typescript
Header.tsx:1:1: CamelCaseMethodName [priority 1] The method Header is not named in camelCase. (context: function Header())
exit=2

## 5 React arrow component and hook constants
$ messcript arrow.tsx text typescript
arrow.tsx:3:14: ConstantNamingConventions [priority 4] Constant Header should be defined in uppercase (context: constant Header)
arrow.tsx:4:14: ConstantNamingConventions [priority 4] Constant useToggle should be defined in uppercase (context: constant useToggle)
exit=2
```

## Variations

`CamelCaseMethodName` with `return <div />`, `return <></>`, `return null`, an early `return null` then JSX, and `cond ? <a /> : null`: all reported. Names `Header`, `QuitOnQ`, `UserCard`, `AppV2`, `MyUI`, `LoginForm`, `A`: all reported.

`ConstantNamingConventions` also reports `const handler = () => 1`, `const config = { port: 1 }`, and a non-exported `const Inner = function () { return <p />; }`. `export const MAX = 3` is not reported.
