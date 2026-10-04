# Changelog

## Unreleased

### Fixed

- Every naming rule now applies the same React component and hook exemption ([#293](https://github.com/quality-gates/messcript/issues/293)). `CamelCaseVariableName`, `CamelCasePropertyName`, and `CamelCaseParameterName` no longer report PascalCase components such as `const Header = () => <h1 />`. Component- and hook-valued class properties (`static readonly Fallback = () => <span />`) and parameters are recognised too, so `ConstantNamingConventions`, `ShortVariable`, and `LongVariable` skip them. `ShortVariable` and `LongVariable` also skip hooks (`useX` functions). Expect fewer findings if you relied on these rules reporting PascalCase arrow functions or long hook names.
