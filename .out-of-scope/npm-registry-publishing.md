# npm Registry Publishing

`messcript` is not published to the npm registry, and there is no plan to
publish it there as the primary distribution channel.

## Why this is out of scope

The project shipped a deliberate distribution model instead: Homebrew-hosted
standalone native executables. The `Release` workflow builds a Node.js
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
for each supported macOS architecture, codesigns it, and publishes it as a
GitHub release asset consumed by `quality-gates/homebrew-tap`
(`docs/homebrew-release.md`). The README states the design goal directly:

> `messcript` is a local CLI. It reads source as text, never runs your
> project, never loads your dependencies, and needs no project config.

A standalone binary is what makes that guarantee possible: there's no
`node_modules` tree, no dependency resolution, and no version drift between
what a user runs and what the maintainers tested. Publishing to npm would mean
maintaining a second install path with a different trust and dependency model
(npm packages still resolve `typescript` as a runtime dependency today), and
would reintroduce the "does the installed thing match what I tested" problem
the native-binary approach exists to avoid.

Earlier in the project's history the README did describe npm publishing as an
upcoming path ("We're working on npm package publishing"), which is what
prompted the original spec and its four child issues. That direction was
superseded once the Homebrew/native-binary release pipeline was built and
merged (#48) — the README no longer mentions npm at all, and `messcript` is
not registered under that name on the npm registry.

Source builds (`git clone` + `npm ci && npm run build`) remain supported as a
contributor/development path, not as the recommended end-user install method.

## Prior requests

- #38: "Spec: publish messcript to the npm registry"
- #39: "Define npm package identity and release contract"
- #40: "Gate npm release on packaged artifact verification"
- #41: "Automate verified npm publication for messcript"
- #42: "Document npm install and release workflow"
