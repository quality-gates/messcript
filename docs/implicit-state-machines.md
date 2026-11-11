# Inventory of Implicit State Machines in messcript

This document catalogs every implicit state machine in `messcript`. In each case, stateful lifecycles, phase flags, or transition sequences are currently implemented through mutable maps, reference counts, or nested conditionals rather than explicit state charts or formal transition tables.

---

## Subsystem 1: Suppressions and Directives

### 1. Line-by-Line Suppression Range Machine
- **Location:** [`src/suppressions.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/suppressions.ts#L51-L100) in `suppressedRulesByLine()`.
- **States Tracked:**
  - `Unsuppressed`: Rule is active for the current line.
  - `RegionSuppressed`: Rule is suppressed by a `messcript-disable` directive with reference count $N \ge 1$.
  - `LineSuppressed`: Rule is suppressed for line $L$ only by a preceding `messcript-disable-next-line` directive.
  - `CompoundSuppressed`: Rule is suppressed by both an active region and a single-line directive.
- **Data Structures Used:**
  - `active: Map<string, number>`: Tracks active region suppression nesting depth per rule name.
  - `nextLine: Map<number, Set<string>>`: Queues single-line suppressions for line $L+1$.
  - `line: number`: Sequential cursor running from line `1` to `lineCount`.
- **Transitions and Events:**
  - `enable(rules)` on line $L$: Decrements reference counts in `active`. If count reaches $\le 1$, deletes rule from `active`.
  - Snapshot: The effective suppression set for line $L$ is computed as $\text{active.keys()} \cup \text{nextLine}[L]$.
  - Expire: `nextLine.delete(L)` purges the single-line rule set.
  - `disable(rules)` on line $L$: Increments reference count in `active`.
  - `disable-next-line(rules)` on line $L$: Appends rules to `nextLine[L + 1]`.
- **Invariants:**
  - A directive on line $L$ must affect line $L$ if it is `disable` or `enable`.
  - `enable` directives must take effect before line $L$'s suppression snapshot is recorded.
  - `disable` and `disable-next-line` directives must take effect after line $L$'s snapshot is recorded.
  - Decrementing a rule count cannot underflow below zero.
  - `disable-next-line` on line $L$ must expire at line $L+1$ and never suppress line $L+2$.
- **Risks and Failure Modes:**
  - Multiple identical `enable` directives can prematurely clear a nested `disable` stack if counts mismatch.
  - Ordering within the loop is sensitive: moving `enable` below the snapshot or `disable` above the snapshot silently alters which lines are suppressed.

---

## Subsystem 2: Rulesets and XML Configuration

### 2. XML Attribute and Quote Lexer Machine
- **Location:** [`src/rulesets.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rulesets.ts#L55-L70) in `tagEnd()`.
- **States Tracked:**
  - `InTagUnquoted`: Scanning characters inside a tag delimiter `< ... >`.
  - `InTagDoubleQuote`: Scanning inside `"..."` attribute value.
  - `InTagSingleQuote`: Scanning inside `'...'` attribute value.
- **Data Structures Used:**
  - `quote: string | undefined`: Holds `"` or `'` when inside a quoted attribute value.
  - `index: number`: Character cursor into the XML string.
- **Transitions and Events:**
  - Encounter `"` while `InTagUnquoted` $\rightarrow$ transition to `InTagDoubleQuote`.
  - Encounter `"` while `InTagDoubleQuote` $\rightarrow$ transition to `InTagUnquoted`.
  - Encounter `'` while `InTagUnquoted` $\rightarrow$ transition to `InTagSingleQuote`.
  - Encounter `'` while `InTagSingleQuote` $\rightarrow$ transition to `InTagUnquoted`.
  - Encounter `>` while `InTagUnquoted` $\rightarrow$ return tag termination index.
  - Encounter `>` while inside quotes $\rightarrow$ ignored as literal attribute text.
- **Invariants:**
  - Tag close delimiter `>` inside attribute strings must not prematurely close the tag.
  - An unclosed quote before EOF must return `-1`.

### 3. XML Pushdown Element Automaton
- **Location:** [`src/rulesets.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rulesets.ts#L100-L190) in `parseXml()`.
- **States Tracked:**
  - `Text`: Reading character text outside of tags.
  - `Comment`: Skipping `<!-- ... -->`.
  - `CData`: Slicing literal text between `<![CDATA[` and `]]>`.
  - `Declaration`: Skipping `<? ... ?>` or `<! ... >`.
  - `OpenTag`: Reading element name and attributes; pushing node onto stack.
  - `CloseTag`: Popping element node from stack and validating name match.
  - `SelfClosingTag`: Attaching child element without pushing onto stack.
- **Data Structures Used:**
  - `stack: XmlNode[]`: Active ancestor element hierarchy.
  - `root: XmlNode | undefined`: Top-level root element.
  - `cursor: number`: Character position in source text.
- **Transitions and Events:**
  - Encounter `<`: Slices accumulated text, appends to `stack.top()`.
  - Matches `<!--`: Searches for `-->`, advances cursor.
  - Matches `<![CDATA[`: Searches for `]]>`, appends verbatim text, advances cursor.
  - Matches `<?` or `<!`: Uses `tagEnd()` to advance cursor.
  - Matches tag: Parses tag name and attributes via `parseTag()`.
    - If `closing`: Pops `stack`. Verifies popped name matches tag name.
    - If `selfClosing`: Appends to `stack.top().children` (or assigns `root`).
    - Otherwise: Appends to parent, pushes to `stack`.
- **Invariants:**
  - Exactly one root element must exist. Text outside the root element is invalid.
  - Closing tag name must match the current top of the stack.
  - Stack must be empty when `cursor` reaches source length.

### 4. Ruleset Inheritance and Cycle Detection Machine
- **Location:** [`src/rulesets.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rulesets.ts#L483-L543) in `expandCustomFile()`, `expandContainer()`, and `expandReference()`.
- **States Tracked:**
  - `Unvisited`: Ruleset file not yet evaluated.
  - `Visiting`: File currently in the active expansion stack.
  - `Visited`: File expansion finished.
  - `CycleDetected`: File path re-encountered while in `Visiting` state.
- **Data Structures Used:**
  - `state.stack: Set<string>`: Set of canonical file paths currently being expanded.
  - `state.path: string`: Current file path context.
  - `state.rulesetName: string`: Current ruleset name context.
- **Transitions and Events:**
  - File reference resolved: Checks if `fullPath` exists in `state.stack`.
  - If in stack: Emits `"Circular ruleset reference"` error and aborts branch.
  - If not in stack: Adds `fullPath` to `state.stack`, recursively expands children, then deletes `fullPath` from `state.stack`.
- **Invariants:**
  - No recursive cycle can cause an infinite loop or stack overflow.
  - Path and ruleset name must be restored on unwind, even if parsing fails.

---

## Subsystem 3: Lexical Scoping and Binding Mutation

### 5. Scope Tree and Variable Mutation Lifecycle
- **Location:** [`src/ast/scopes.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/ast/scopes.ts#L301-L407) in `ScopeBuilder` and `analyzeScopes()`.
- **States Tracked:**
  - Binding Lifecycle: `Declared` $\rightarrow$ `Referenced` $\rightarrow$ `Mutated`.
  - Scope Chain: Tree of `Scope` objects (`file`, `namespace`, `function`, `class`, `block`).
- **Data Structures Used:**
  - `bindingsByScope: Map<Scope, Map<string, MutableBinding>>`: Scoped symbol tables.
  - `references: Array<[ts.Identifier, Scope]>`: Deferred reference resolution queue.
  - `writes: Map<ts.Node, Write>`: Write classification records (`contents`, `viaCall`, `reassign`, `compound`).
- **Transitions and Events:**
  - Walk node:
    - On scope boundary: Creates child `Scope` node linked to parent `scope`.
    - On declaration: `var` declarations hoist to nearest `function`, `namespace`, or `file` scope via `hoistingScope()`. `let`/`const` bind to immediate block.
    - On identifier reference: Pushes `[identifier, scope]` to `references`.
    - On write target: Records write attributes in `writes`.
  - Resolution pass: For each `[identifier, scope]`, traverses parent scope chain via `lookup()`. Links reference to nearest binding.
  - Mutation pass: For each write target, resolves binding. If `!write.viaCall` and `!isLoopUpdateWrite()`, sets `binding.mutated = true`.
- **Invariants:**
  - Inner declarations shadow outer declarations of the same name.
  - `var` declarations ignore block boundaries and hoist to the containing function/module.
  - Loop incrementors (e.g. `i++` in `for (let i = 0; ...; i++)`) do not mark `i` as mutated for closure escape analysis.
  - Mutation through function calls (`f().x = 1`) does not mark `f` as mutated.

---

## Subsystem 4: Inter-Procedural Flow Analysis

### 6. Inter-Procedural Summary Fixed-Point Lattice
- **Location:** [`src/analysis/explicitness.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/analysis/explicitness.ts#L2930-L2975) in `analyzeImplicitFlows()`.
- **States Tracked:**
  - `Initial`: Empty callable summaries (`flows: []`, `parameterWrites: []`, `returnedAliases: []`).
  - `Iterating`: Re-evaluating callables with summaries from the previous iteration.
  - `Converged`: All summary keys and shared binding counts match the previous round.
  - `Unconverged`: Iteration count reaches `callables.length + 8` without stabilizing.
- **Data Structures Used:**
  - `summaries: Map<EffectOwner, CallableSummary>`: Current facts per callable.
  - `state.sharedBindings: Map<Binding, Set<string>>`: Tracked mutated slots.
  - `converged: boolean`: Stabilization status flag.
  - `index: number`: Bound counter running up to `callables.length + 8`.
- **Transitions and Events:**
  - Round start: Sets `state.summaries = summaries`.
  - Round execution: Computes `summary = summarizeCallable(state, summaries, owner)`. Checks delta using `summaryKey(summary)`.
  - Convergence check: If `!changed && sharedCount === sharedBindingCount(state)`, sets `converged = true` and breaks loop.
  - Completion: If `!converged`, synthesizes fallback `unknownEffects("has effects this analysis did not resolve")` for all callables.
- **Invariants:**
  - Summary propagation must terminate within `callables.length + 8` rounds.
  - If analysis does not converge, it must conservatively emit `unknown` effect findings rather than claiming purity.

---

## Subsystem 5: Clean Code and Design Rule Verification

### 7. Object Literal Key Collision Machine
- **Location:** [`src/rules/duplicated-array-key.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/duplicated-array-key.ts#L106-L145) in `checkObjectLiteral()`.
- **States Tracked:**
  - Per static key: `Empty` $\rightarrow$ `ValueOnly` | `GetOnly` | `SetOnly` | `GetAndSet` $\rightarrow$ `Conflict`.
- **Data Structures Used:**
  - `seen: Map<string, KeyRecord>` where `KeyRecord` holds `{ get?: { line }, set?: { line }, value?: { line } }`.
- **Transitions and Events:**
  - Key observed with kind `get`:
    - If already has `get` or `value` $\rightarrow$ conflict with previous line.
    - If has `set` $\rightarrow$ transitions to `GetAndSet`.
    - If empty $\rightarrow$ records `get: { line }`.
  - Key observed with kind `set`:
    - If already has `set` or `value` $\rightarrow$ conflict with previous line.
    - If has `get` $\rightarrow$ transitions to `GetAndSet`.
    - If empty $\rightarrow$ records `set: { line }`.
  - Key observed with kind `value`:
    - If already has `value`, `get`, or `set` $\rightarrow$ conflict with previous line.
    - If empty $\rightarrow$ records `value: { line }`.
- **Invariants:**
  - An object literal may define both a getter and a setter for the same key.
  - Multiple getters, multiple setters, or mixed getter/setter with a value property are invalid duplicates.

### 8. Regex Compilation and ReDoS Safety Cache Machine
- **Location:** [`src/rules/ignore-pattern.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/ignore-pattern.ts#L174-L203) in `compileIgnorePattern()`.
- **States Tracked:**
  - `Uncached`: Pattern not yet verified.
  - `CachedValid`: Pattern passed safety probes, compiled `RegExp` cached.
  - `CachedPermanentError`: Pattern has invalid syntax; permanent error cached.
  - `TransientTimeout`: Probe evaluation timed out ($>80$ ms probe or $>3000$ ms child); error thrown with `transient: true`, not cached.
- **Data Structures Used:**
  - `compileCache: Map<string, CacheEntry>` where `CacheEntry` is `{ regex }` or `{ error }`.
- **Transitions and Events:**
  - Cache lookup: Returns cached `regex` or throws cached permanent `error`.
  - Probe execution: Executes isolated child process with `safetyProbes`.
  - Syntax error: Stores `{ error }` in `compileCache` and throws.
  - Timeout or runtime exceedance: Throws `IgnorePatternError({ transient: true })`. Bypasses cache write.
  - Probe success: Stores `{ regex }` in `compileCache`.
- **Invariants:**
  - Permanent syntax errors must never re-probe on subsequent calls.
  - Transient timeouts caused by system load must not poison the cache.

### 9. Private Member Usage and Uncertainty Machine
- **Location:** [`src/analysis/unused.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/analysis/unused.ts#L102-L252) in `UnusedAnalyzer`.
- **States Tracked:**
  - Per private field or method: `Unused` (`used: false, uncertain: false`), `Used` (`used: true`), `Uncertain` (`uncertain: true`).
- **Data Structures Used:**
  - `declarations: UnusedDeclaration[]`: Member list with `used` and `uncertain` flags.
  - `classesByNode: Map<ts.Node, ClassInfo>`: Enclosing class lookup.
- **Transitions and Events:**
  - Member declaration: Initialized to `used = false`.
  - Static property access (`this.field`): If not write-only, sets `member.used = true`.
  - Dynamic element access (`this[expr]`): Invokes `markClassUncertain()`, setting `member.uncertain = true` on every private member in the class.
  - Filtering: Only declarations with `!used && !uncertain` are reported.
- **Invariants:**
  - Write-only assignments (`this.x = 1`) do not count as uses.
  - Any dynamic indexing on `this` forces all private members in that class to `uncertain`.

### 10. Class Cohesion Graph Machine (LCOM4)
- **Location:** [`src/metrics/cohesion.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/metrics/cohesion.ts#L322-L370) in `UnionFind`.
- **States Tracked:**
  - Disjoint-set partition over methods: `Inactive` $\rightarrow$ `Active` $\rightarrow$ `MergedRoot`.
- **Data Structures Used:**
  - `parents: number[]`: Tree pointers.
  - `active: boolean[]`: Methods participating in field access or calls.
  - `fieldOwners: Map<string, number>`: First method accessing each field.
- **Transitions and Events:**
  - `addFieldUse(method, field)`: Sets `active[method] = true`. If field already has an owner, merges `union(method, owner)`. Otherwise records owner.
  - `addCall(caller, callee)`: Sets both active; merges `union(caller, callee)`.
  - `countComponents()`: Resolves root representatives using path compression.
- **Invariants:**
  - Methods sharing a field or calling each other belong to the same component.
  - Backing accessors with single statements are folded directly into field accesses.

### 11. Multi-File Global State Mutation Accumulator
- **Location:** [`src/rules/global-variable.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/global-variable.ts#L485-L528) in `findGlobalVariable()`.
- **States Tracked:**
  - Module variable binding or static class field: `CandidateImmutable` $\rightarrow$ `Mutated`.
- **Data Structures Used:**
  - `mutatedBindings: Set<Binding>`: Mutated module-level variables.
  - `mutatedFields: Set<StaticField>`: Mutated static properties.
- **Transitions and Events:**
  - Pass 1: Collects all module variables and static properties across all source files.
  - Pass 2: Inspects assignment expressions, mutating methods (`push`, `set`, etc.), and `Object.assign`. If target resolves to candidate without local shadowing, adds to `mutatedBindings` or `mutatedFields`.
  - Reporting: Flags members present in mutated sets (or all if `report-immutable` is enabled).
- **Invariants:**
  - Local shadowing inside a function body prevents an assignment from marking the outer global as mutated.
  - Scripts sharing non-module scopes track mutations across files.

---

## Subsystem 6: CLI Engine and Discovery Pipeline

### 12. CLI Streaming Argument Parser and Exit Code Machine
- **Location:** [`src/cli.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/cli.ts#L142-L370) in `parseArguments()` and `runCli()`.
- **States Tracked:**
  - Parser Mode: `Scanning` $\rightarrow$ `ConsumingOptionValue` $\rightarrow$ `PositionalsResolved` $\rightarrow$ `Help` | `Version` | `Execute`.
  - Exit Code Resolution:
    - `0`: Clean execution, `--help`, `--version`, or suppressed via `--ignore-errors-on-exit` / `--ignore-violations-on-exit`.
    - `1`: Operational error (invalid arguments, parse failures, unhandled exceptions).
    - `2`: Analysis findings detected and not suppressed.
- **Data Structures Used:**
  - `argv: string[]`: Raw argument array.
  - `positional: string[]`: Accumulated positional values.
  - `parsedArguments`: Flag and option container.
- **Transitions and Events:**
  - `-h` / `--help` encountered $\rightarrow$ sets `showHelp = true`, returns code `0`.
  - `-v` / `--version` encountered $\rightarrow$ sets `showVersion = true`, returns code `0`.
  - Positional argument $< 3$ $\rightarrow$ throws `CliError` with missing argument text.
  - Option requiring value: consumes `argv[index + 1]` and increments index.
  - Analysis finished:
    - If `errors.length > 0` and not `--ignore-errors-on-exit` $\rightarrow$ returns `1`.
    - If `findings.length > 0` and not `--ignore-violations-on-exit` $\rightarrow$ returns `2`.
    - Otherwise $\rightarrow$ returns `0`.
- **Invariants:**
  - Exit code `2` must only be returned when violations exist and operational errors are absent.
  - Operational errors take precedence over violations unless `--ignore-errors-on-exit` is specified.

### 13. File Discovery and Inode Loop Avoidance Walker
- **Location:** [`src/discovery.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/discovery.ts#L81-L143) in `addSourceFiles()`.
- **States Tracked:**
  - Directory Identity: `Unvisited` $\rightarrow$ `Visited` (tracked by `${stat.dev}:${stat.ino}`).
  - Test Context: `TestDirectory` | `TestFile` | `SourceFile`.
- **Data Structures Used:**
  - `visitedDirectories: Set<string>`: Inode identities to stop circular symlinks.
  - `files: Map<string, boolean>`: File path to `isTest` boolean mapping.
- **Transitions and Events:**
  - Inode inspection: Reads `statSync(path).dev` and `.ino`.
  - Cycle detection: If identity in `visitedDirectories`, stops traversal immediately.
  - Directory entry: Adds identity to `visitedDirectories`, reads entries, recurses.
  - File entry: If matching extension, records in `files`. Preserves non-test status if reached through multiple paths.
- **Invariants:**
  - Recursive directory symlinks must terminate without throwing `ELOOP`.
  - A file reached as non-test from one root remains non-test even if another root classifies it as test.
