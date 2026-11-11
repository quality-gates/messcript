---
name: verify-cli-discovery
description: "Formally verify the CLI streaming argument parser, exit code resolution, and inode loop avoidance walker in messcript/src/cli.ts and src/discovery.ts using TLA+ and statechart. Use whenever modifying command-line options, exit codes, or directory traversal."
---

# Verify CLI & Discovery State Machine

This skill formally verifies the CLI argument execution lifecycle and file discovery inode walker in [`src/cli.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/cli.ts#L142-L370) and [`src/discovery.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/discovery.ts#L81-L143) using a TLA+ model checked by TLC via the pstack `/statechart` skill.

## Covered code

- **Files:** [`src/cli.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/cli.ts), [`src/discovery.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/discovery.ts)
- **Functions:** `runCli()`, `parseArguments()`, `discoverSourceFiles()`, `addSourceFiles()`
- **Sync commit:** `ee472067793f11a44fec4f7699cd46cedc039c64`

## Properties verified

1. **`Code2Contract`**: Exit code `2` is returned if and only if code violations are present and unignored operational errors are absent.
2. **`ErrorPrecedence`**: When operational processing errors occur, exit code `1` strictly takes precedence over exit code `2`, unless `--ignore-errors-on-exit` is provided.
3. **`LoopAvoidance`**: Traversal tracks visited filesystem identities (`dev:ino`), preventing recursive directory symlinks from causing infinite loops or `ELOOP` crashes.
4. **`NoDeadlock`**: The execution pipeline always terminates in an exit code (`0`, `1`, or `2`).

## How to run

Run the verification using `/statechart`:

```sh
.agents/skills/statechart/scripts/statechart quality-gates/messcript/formal/cli-discovery/CliDiscovery.tla --config quality-gates/messcript/formal/cli-discovery/CliDiscovery.cfg --out quality-gates/messcript/formal/cli-discovery/out
```

Read every result with the pstack `/statechart` skill. If TLC finds an invariant violation, `/statechart` reports the shortest counterexample path in plain words. When the check passes, it generates a Mermaid statechart in `quality-gates/messcript/formal/cli-discovery/out/chart.mmd`.

## Bounds and assumptions

- Scope: Bounded to 3 directory inodes across the 5 CLI lifecycle phases.
- Assumption: Filesystem metadata provides valid integer device and inode numbers.
