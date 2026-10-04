# Changelog

## Unreleased

### Fixed

- `ExitExpression` and `DevelopmentCodeFragment` no longer report calls whose root name is a local declaration, such as `process.exit(1)` on a `process` parameter or `console.log()` on a `console` parameter ([#294](https://github.com/quality-gates/messcript/issues/294)). Both rules and `ImplicitInput`/`ImplicitOutput` now share one host-global resolver, so they agree on what `process`, `console`, `window`, and `exit` refer to. Names from `unwanted-functions` and the `debug.*` defaults still match a locally bound root, such as `const logger = pino()`.
- Every naming rule now applies the same React component and hook exemption ([#293](https://github.com/quality-gates/messcript/issues/293)). `CamelCaseVariableName`, `CamelCasePropertyName`, and `CamelCaseParameterName` no longer report PascalCase components such as `const Header = () => <h1 />`. Component- and hook-valued class properties (`static readonly Fallback = () => <span />`) and parameters are recognised too, so `ConstantNamingConventions`, `ShortVariable`, and `LongVariable` skip them. `ShortVariable` and `LongVariable` also skip hooks (`useX` functions). Expect fewer findings if you relied on these rules reporting PascalCase arrow functions or long hook names.
