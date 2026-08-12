# Coding standards

## Tests

- Strongly prefer integration tests and end-to-end tests over unit tests.
- Strongly prefer exercising real system behaviour over "the tests pass so it must work."
- Only mock third-party services we cannot control. Do not mock code we own.
- For this codebase, the default proof is: run the real CLI/analyzer on real (or fixture) source and assert findings, exit codes, and report output.

## Comments and docs

- Code comments use ASD-STE100 Simplified Technical English.
- Ground terms in `CONTEXT.md` domain language when that file exists. Do not invent synonyms for glossary terms.
- Do not write comments that only repeat what the code already makes clear.
- Do not put brittle references in README or comments (versions, line numbers, temporary paths, "as of today" claims) when those details are allowed to change.

## Common footguns

- Tautological tests (asserting the mock was called the way the test just configured it).
- Mocks of modules/services we own.
- "Green suite" treated as proof the product works for a user.
- Narrating comments and README drift magnets.
- Cheating complexity or quality gates with denser syntax, hidden branching, or indirection that does not reduce real complexity.

## TypeScript

- `strict` TypeScript only. No `any`. Prefer `unknown` + narrowing at boundaries.
- Match the project module system: CommonJS emit (`"module": "CommonJS"`), Node resolution, `target` ES2022. Do not silently migrate to ESM.
- Runtime dependency posture stays minimal (TypeScript as the analyzer stack). Do not add framework or utility packages for problems solvable with stdlib/`node:` APIs.
- Use `node:` protocol imports for built-ins (`node:fs`, `node:path`, …).
- Prefer `import type` for type-only imports. Prefer `readonly` / `Readonly<>` for data that must not be mutated after construction.
- Export small, named functions and types from focused modules under `src/` (`analysis`, `ast`, `metrics`, `reporters`, `rules`, …). Avoid default exports and god-files.
- Parse TS/JS through the existing TypeScript compiler API usage in-tree. Do not add a second parser (Babel, acorn, etc.).
- Tests are Node’s built-in test runner on built output (`node --test test/*.test.mjs` after `tsc`). Prefer tests that run the CLI or public surface against `test/fixtures/`.
- Keep `engines.node` (`>=20.11.0`) honest — do not use newer APIs without bumping the engine floor.
- No `as` casts to silence the typechecker. If a cast is unavoidable, narrow first and keep the assertion at the boundary.
