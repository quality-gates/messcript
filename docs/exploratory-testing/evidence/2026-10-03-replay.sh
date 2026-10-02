#!/bin/sh
# Replays each confirmed 2026-10-03 finding from a fresh fixture directory.
# Usage: MX="node /path/to/messcript/dist/cli.js" sh replay.sh
set -u
MX=${MX:-"node dist/cli.js"}
D=$(mktemp -d)
cd "$D"
run() { echo "\$ messcript $*"; $MX "$@"; echo "exit=$?"; echo; }

echo "## 1 marker substrings"
printf '// Post the update to Mastodon.\nexport const A = 1;\n// Remove the shackles from the queue.\nexport const B = 2;\n// TODO: real marker\nexport const C = 3;\n' > words.ts
run words.ts text typescript

echo "## 2 React function component"
printf 'export function Header() {\n  return <h1>Hi</h1>;\n}\n' > Header.tsx
run Header.tsx text typescript

echo "## 5 React arrow component and hook constants"
printf 'import { useState } from "react";\n\nexport const Header = () => <h1>Hi</h1>;\nexport const useToggle = () => useState(false);\n' > arrow.tsx
run arrow.tsx text typescript

echo "## 3 locally bound exit"
printf 'import { useApp, useInput } from "ink";\n\nexport function quitOnQ() {\n  const { exit } = useApp();\n  useInput((input) => {\n    if (input === "q") {\n      exit();\n    }\n  });\n  return null;\n}\n' > quit.tsx
run quit.tsx text typescript,opinionated

echo "## 4 global-object receivers"
printf 'export function shutdown(code: number) {\n  globalThis.process.exit(code);\n}\nexport function trace(value: unknown) {\n  window.console.log(value);\n  globalThis.console.log(value);\n}\n' > globals.ts
run globals.ts text typescript,opinionated
printf 'export function shutdown(code: number) {\n  process.exit(code);\n}\nexport function trace(value: unknown) {\n  console.log(value);\n}\n' > control.ts
run control.ts text typescript,opinionated
rm -rf "$D"
