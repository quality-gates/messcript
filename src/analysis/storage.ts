import ts from "typescript";
import type { ScopeModel } from "../ast/scopes";
import { unwrapExpression } from "../ast/expressions";
import { globalName } from "../ast/global-reference";

/**
 * Where storage can come from.
 * Private storage is created by the function. External storage outlives it, as a module or captured binding does.
 * Receiver storage belongs to this. A parameter origin names the argument that supplies the storage.
 * Unknown storage has an origin this analysis does not trace.
 */
export type StorageOrigin = `host:${string}` | "private" | "unknown" | "external" | "receiver" | `private:${number}` | `private:${number}:${string}` | `param:${number}` | `param:${number}:${string}` | `external:${number}` | `external:${number}:${string}`;

/** The origins of a value's own storage, its direct references, and the storage reachable at the query site. */
export type StorageFact = {
  readonly outer: readonly StorageOrigin[];
  readonly reachable: readonly StorageOrigin[];
  readonly cells?: readonly StorageCell[];
};

export type StorageCell = {
  readonly allocation: StorageOrigin;
  readonly slot: string;
  readonly origins: readonly StorageOrigin[];
};

export type StoragePath = "outer" | "reachable" | readonly string[];

const PRIVATE_FACT: StorageFact = { outer: ["private"], reachable: ["private"] };

export function freshStorageFact(value: ts.Expression): StorageFact {
  return allocatedFact(value, []);
}

export function invokedStorageFact(fact: StorageFact, call: ts.Node): StorageFact {
  const rebase = (origins: readonly StorageOrigin[]) => joinOrigins(origins.map((origin) => invocationOrigin(origin, call.getStart())));
  return mapStorageFact(fact, rebase, rebase);
}

function invocationOrigin(origin: StorageOrigin, site: number): StorageOrigin {
  if (!origin.startsWith("private:")) {
    return origin;
  }
  const [, allocation, context = ""] = origin.split(":");
  if (context === "*") {
    return `private:${Number(allocation)}:*`;
  }
  const calls = new Set(context.split(",").filter((value) => value.length > 0));
  calls.add(String(site));
  const next = calls.size > 2 ? "*" : [...calls].sort().join(",");
  return `private:${Number(allocation)}:${next}`;
}

export function elementFact(fact: StorageFact): StorageFact {
  return memberStorageFact(fact);
}

export function originsForPath(fact: StorageFact, path: StoragePath): readonly StorageOrigin[] {
  if (path === "outer") {
    return fact.outer;
  }
  if (path === "reachable") {
    return fact.reachable;
  }
  return path.reduce((value, slot) => memberStorageFact(value, slot), fact).outer;
}

export function parameterOriginIndexes(origins: readonly StorageOrigin[]): number[] {
  return origins.flatMap((origin) => {
    const projection = parameterProjection(origin);
    return projection ? [projection.parameterIndex] : [];
  });
}

export function parameterProjection(origin: StorageOrigin): { parameterIndex: number; path: readonly string[] } | undefined {
  if (!origin.startsWith("param:")) {
    return undefined;
  }
  const [, index, path = ""] = origin.split(":");
  return { parameterIndex: Number(index), path: path ? path.split("/").map(decodeURIComponent) : [] };
}

/** Splits an external origin into the binding's own origin and the member path selected from it. */
export function externalProjection(origin: StorageOrigin): { base: `external:${number}`; path: readonly string[] } | undefined {
  if (!origin.startsWith("external:")) {
    return undefined;
  }
  const [, binding, path = ""] = origin.split(":");
  return { base: `external:${Number(binding)}`, path: path ? path.split("/").map(decodeURIComponent) : [] };
}

const MAX_PROJECTION_DEPTH = 3;

/** Tells if a projected path stands for all it holds, so the slots selected below it were absorbed. */
export function absorbsSlots(path: readonly string[]): boolean {
  return path.length >= 2 && path[path.length - 1] === "*";
}

function projectedPath(path: readonly string[], slot: string): string {
  if (absorbsSlots(path)) {
    return path.map(encodeURIComponent).join("/");
  }
  const next = path.length >= MAX_PROJECTION_DEPTH ? [...path.slice(0, MAX_PROJECTION_DEPTH - 1), "*"] : [...path, slot];
  return next.map(encodeURIComponent).join("/");
}

export function hostName(origin: StorageOrigin): string | undefined {
  if (!origin.startsWith("host:")) { return undefined; }
  const [root = "", ...path] = origin.slice(5).split("/");
  const slots = path.map(decodeURIComponent);
  const name = decodeURIComponent(root);
  return !name.includes(".") && slots.every((slot) => slot.startsWith("property:") &&
    slot.length > 9 && !slot.slice(9).includes("."))
    ? [name, ...slots.map((slot) => slot.slice(9))].filter(Boolean).join(".") : undefined;
}

function projectedHostOrigin(origin: `host:${string}`, slot: string): StorageOrigin {
  if (origin === "host:" && slot.startsWith("property:")) {
    const name = slot.slice(9);
    if (["globalThis", "window", "self"].includes(name)) { return origin; }
    return name ? `host:${encodeURIComponent(name)}` : "host:/property%3A";
  }
  const [root = "", ...path] = origin.slice(5).split("/");
  return `host:${root}/${projectedPath(path.map(decodeURIComponent), slot)}`;
}

function projectedOrigin(origin: StorageOrigin, slot: string): StorageOrigin {
  if (origin.startsWith("host:")) {
    return projectedHostOrigin(`host:${origin.slice(5)}`, slot);
  }
  const projection = parameterProjection(origin);
  if (projection) {
    return `param:${projection.parameterIndex}:${projectedPath(projection.path, slot)}`;
  }
  const external = externalProjection(origin);
  return external ? `${external.base}:${projectedPath(external.path, slot)}` : origin;
}

export function hasExternalOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.some((origin) => origin === "external" || origin.startsWith("external:") || origin.startsWith("host:"));
}

export function hasUnknownOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.includes("unknown");
}

export function hasReceiverOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.includes("receiver");
}

export function joinStorageFacts(facts: readonly StorageFact[]): StorageFact {
  const [first, ...rest] = facts;
  return first ? rest.reduce(joinFacts, first) : PRIVATE_FACT;
}

export function joinStorageOrigins(origins: readonly StorageOrigin[]): readonly StorageOrigin[] {
  return joinOrigins(origins);
}

export function memberStorageFact(fact: StorageFact, slot?: string): StorageFact {
  const origins = fact.outer.flatMap((allocation) => allocationMemberOrigins(fact, allocation, slot));
  const outer = joinOrigins(origins);
  const cells = pruneCells(outer, fact.cells ?? []);
  return { outer, reachable: reachableOrigins(outer, cells), cells };
}

function allocationMemberOrigins(fact: StorageFact, allocation: StorageOrigin, slot: string | undefined): readonly StorageOrigin[] {
  const cells = fact.cells?.filter((cell) => cell.allocation === allocation);
  const projected = projectedMemberOrigins(fact, allocation, slot);
  if (!cells?.length) {
    return projected;
  }
  const matched = cells.filter((cell) => cell.slot !== "@allocation" && (cell.slot !== KEY_SLOT || slot === "*" || slot === KEY_SLOT) && cellMatchesSlot(cell.slot, slot)).flatMap((cell) => cell.origins);
  return isClosedMemberSlot(cells, slot) ? matched : [...matched, ...projected];
}

function projectedMemberOrigins(fact: StorageFact, allocation: StorageOrigin, slot: string | undefined): readonly StorageOrigin[] {
  const shaped = fact.cells?.some((cell) => cell.allocation === allocation);
  const base: readonly StorageOrigin[] = shaped ? [allocation] : fact.outer.length === 1
    ? fact.reachable : fact.reachable.includes(allocation) ? [allocation] : ["private"];
  return base.map((origin) => projectedOrigin(origin, slot ?? "*"));
}

function isClosedMemberSlot(cells: readonly StorageCell[], slot: string | undefined): boolean {
  return cells.some((cell) => cell.slot === "@allocation") ||
    (slot !== undefined && slot !== "*" && cells.some((cell) => cell.slot === slot));
}

function cellMatchesSlot(cellSlot: string, selectedSlot: string | undefined): boolean {
  if (selectedSlot === undefined || selectedSlot === "*" || cellSlot === "*" || cellSlot === selectedSlot) {
    return true;
  }
  if (cellSlot.startsWith(EXCEPT)) {
    return !exceptedSlots(cellSlot).includes(selectedSlot);
  }
  const start = cellSlot.startsWith("append:") ? Number(cellSlot.slice(7)) : undefined;
  const index = arrayIndexForSlot(selectedSlot);
  return start !== undefined && index !== undefined && index >= start;
}

export function arrayIndexForSlot(slot: string | undefined): number | undefined {
  if (!slot?.startsWith("property:")) {
    return undefined;
  }
  const text = slot.slice(9);
  const index = Number(text);
  return String(index) === text && Number.isInteger(index) && index >= 0 && index < 4294967295 ? index : undefined;
}

export function isCellAllocation(origin: StorageOrigin): boolean {
  return origin !== "private" && origin !== "unknown" && origin !== "receiver";
}

export function mapStorageFact(
  fact: StorageFact,
  outer: (origins: readonly StorageOrigin[]) => readonly StorageOrigin[],
  reachable: (origins: readonly StorageOrigin[]) => readonly StorageOrigin[],
  imported: readonly StorageCell[] = [],
): StorageFact {
  const mappedOuter = outer(fact.outer);
  const cells = pruneCells(mappedOuter, [
    ...(fact.cells ?? []).flatMap((cell) => outer([cell.allocation])
      .filter(isCellAllocation)
      .map((allocation) => ({
        allocation, slot: cell.slot, origins: outer(cell.origins),
      }))), ...imported,
  ]);
  return { outer: mappedOuter, reachable: reachable(fact.reachable), cells };
}

/**
 * Names an allocation by its node's span, since a call on a fresh receiver, as new Map(e).values(), starts where the
 * receiver's allocation does.
 */
export function allocationId(node: ts.Node): number {
  return node.getStart() * (node.getSourceFile().end + 1) + node.end;
}

export function allocatedFact(value: ts.Node, parts: readonly { slot: string; fact: StorageFact }[]): StorageFact {
  const allocation: StorageOrigin = `private:${allocationId(value)}`;
  const heap = new CellHeap();
  const initial = { allocation, slot: "@allocation", origins: ["private"] } satisfies StorageCell;
  heap.set(initial);
  for (const { slot, fact } of parts) {
    for (const cell of fact.cells ?? []) {
      heap.set(cell);
    }
    applyHeapWrite(heap, { target: { outer: [allocation], reachable: [] }, value: fact,
      slot, replace: !isWildcardSlot(slot) });
  }
  const cells = pruneCells([allocation], heap.values());
  return { outer: [allocation], reachable: reachableOrigins([allocation], cells), cells };
}

/**
 * Renames the fresh storage a fact holds as storage selected from the base, as a module constant's array is reached from
 * outside the module. Each renamed allocation stays open, since other code can store into it.
 */
export function rebasedFact(fact: StorageFact, base: StorageOrigin): StorageFact {
  const names = new Map<StorageOrigin, StorageOrigin>();
  const pending = fact.outer.map((origin) => ({ origin, name: base }));
  for (const { origin, name } of pending) {
    if (!names.has(origin)) {
      names.set(origin, name);
      pending.push(...(fact.cells ?? []).filter((cell) => cell.allocation === origin).flatMap((cell) => heldNames(cell, name)));
    }
  }
  const rename = (origins: readonly StorageOrigin[]): readonly StorageOrigin[] => joinOrigins(origins.map((origin) => names.get(origin) ?? origin));
  const renamed = new Set(names.values());
  const cells = mapStorageFact(fact, rename, rename).cells?.filter((cell) => cell.slot !== "@allocation" || !renamed.has(cell.allocation)) ?? [];
  const outer = rename(fact.outer);
  return { outer, reachable: reachableOrigins(outer, cells), cells };
}

/** Names the fresh storage a cell holds by the member that holds it, so "rows[0]" and "rows[1]" stay apart. */
function heldNames(cell: StorageCell, name: StorageOrigin): { origin: StorageOrigin; name: StorageOrigin }[] {
  const slot = cell.slot.startsWith("property:") ? cell.slot : "*";
  return cell.origins.filter((item) => item.startsWith("private:")).map((item) => ({ origin: item, name: projectedOrigin(name, slot) }));
}

export function knownMemberFact(base: StorageFact, members: readonly { slot: string; fact: StorageFact }[]): StorageFact {
  const residual = base.outer.map((allocation) => ({ allocation, slot: "*", origins: base.reachable }));
  return withInsertions({ ...base, cells: [...(base.cells ?? []), ...residual] },
    members.map(({ slot, fact }) => ({ target: base, value: fact, slot, replace: true })));
}

function reachableOrigins(roots: readonly StorageOrigin[], cells: readonly StorageCell[]): readonly StorageOrigin[] {
  const reached = new Set<StorageOrigin>();
  const pending = [...roots];
  const visited = new Set<StorageOrigin>();
  const contentsOf = cellOriginsByAllocation(cells);
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const origins = contentsOf.get(current) ?? [current];
    for (const origin of origins) {
      reached.add(origin);
      pending.push(origin);
    }
  }
  return joinOrigins([...reached]);
}

function cellOriginsByAllocation(cells: readonly StorageCell[]): Map<StorageOrigin, StorageOrigin[]> {
  const contents = new Map<StorageOrigin, StorageOrigin[]>();
  for (const cell of cells) {
    const origins = contents.get(cell.allocation);
    if (origins) {
      origins.push(...cell.origins);
    } else {
      contents.set(cell.allocation, [...cell.origins]);
    }
  }
  return contents;
}

function cellKey(cell: StorageCell): string {
  return `${cell.allocation}/${cell.slot}`;
}

// The same order as String.prototype.localeCompare, without building a collator per comparison.
const CELL_ORDER = new Intl.Collator();

function mergeCells(cells: readonly StorageCell[]): StorageCell[] {
  const result = new Map<string, { cell: StorageCell; origins: StorageOrigin[] }>();
  for (const cell of cells) {
    const key = cellKey(cell);
    const merged = result.get(key);
    if (merged) {
      merged.cell = cell;
      merged.origins.push(...cell.origins);
    } else {
      result.set(key, { cell, origins: [...cell.origins] });
    }
  }
  return [...result].sort(([left], [right]) => CELL_ORDER.compare(left, right))
    .map(([, { cell, origins }]) => ({ ...cell, origins: joinOrigins(origins) }));
}

/** Cells by key, with each allocation's cells kept apart in the same order so a write reads only its own. */
class CellHeap {
  private readonly cells = new Map<string, StorageCell>();
  private readonly allocations = new Map<StorageOrigin, Map<string, StorageCell>>();

  set(cell: StorageCell): void {
    const key = cellKey(cell);
    this.cells.set(key, cell);
    const own = this.allocations.get(cell.allocation);
    if (own) {
      own.set(key, cell);
    } else {
      this.allocations.set(cell.allocation, new Map([[key, cell]]));
    }
  }

  delete(cell: StorageCell): void {
    const key = cellKey(cell);
    this.cells.delete(key);
    this.allocations.get(cell.allocation)?.delete(key);
  }

  cellsOf(allocation: StorageOrigin): StorageCell[] {
    return [...this.allocations.get(allocation)?.values() ?? []];
  }

  values(): StorageCell[] {
    return [...this.cells.values()];
  }
}

function pruneCells(outer: readonly StorageOrigin[], cells: readonly StorageCell[]): StorageCell[] {
  if (cells.length === 0) {
    return [];
  }
  const merged = mergeCells(cells);
  const reachable = new Set<StorageOrigin>([...outer, ...reachableOrigins(outer, merged)]);
  return merged.filter((cell) => reachable.has(cell.allocation));
}

export function joinFacts(left: StorageFact, right: StorageFact): StorageFact {
  const outer = joinOrigins([...left.outer, ...right.outer]);
  return {
    outer,
    reachable: joinOrigins([...left.reachable, ...right.reachable]),
    cells: pruneCells(outer, [...(left.cells ?? []), ...(right.cells ?? [])]),
  };
}

export function joinOrigins(origins: readonly StorageOrigin[]): readonly StorageOrigin[] {
  const unique = [...new Set(origins)].filter((origin) => origin !== "private");
  return unique.length === 0 ? ["private"] : unique.sort();
}

export function shallowStorageFact(value: ts.Node, source: StorageFact): StorageFact {
  if (entryCells(source)) {
    return allocatedFact(value, [{ slot: "*", fact: reachedFact(source) }]);
  }
  const cells = source.cells?.filter((cell) => source.outer.includes(cell.allocation));
  return cells?.length ? allocatedFact(value, cells.map((cell) => ({ slot: cell.slot,
    fact: { outer: cell.origins, reachable: reachableOrigins(cell.origins, source.cells ?? []), cells: source.cells } })))
    : allocatedFact(value, [{ slot: "*", fact: elementFact(source) }]);
}

export function arrayLiteralFact(value: ts.Expression, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  if (!ts.isArrayLiteralExpression(value)) {
    return { outer: ["unknown"], reachable: ["unknown"] };
  }
  const only = value.elements.length === 1 ? value.elements[0] : undefined;
  if (only && ts.isSpreadElement(only)) {
    const source = resolve(only.expression);
    return entryCells(source) ? allocatedFact(value, [{ slot: "*", fact: iteratedFact(source, only) }]) : shallowStorageFact(value, source);
  }
  let lowerBound = 0;
  let exact = true;
  return allocatedFact(value, value.elements.map((element) => {
    const spread = ts.isSpreadElement(element);
    const slot = exact && !spread ? `property:${lowerBound}` : `append:${lowerBound}`;
    exact &&= !spread;
    lowerBound += Number(!spread);
    return { slot, fact: spread ? iteratedFact(resolve(element.expression), element) : resolve(element) };
  }));
}

export function objectLiteralFact(value: ts.Expression, resolve: (value: ts.Expression) => StorageFact, callable?: (method: ts.MethodDeclaration) => StorageFact): StorageFact {
  if (!ts.isObjectLiteralExpression(value)) {
    return { outer: ["unknown"], reachable: ["unknown"] };
  }
  const parts = value.properties.flatMap((property) => propertyParts(property, resolve, callable));
  return allocatedFact(value, parts.map((part, index) => isWildcardSlot(part.slot)
    ? { ...part, slot: exceptSlot(part.slot, parts.slice(index + 1).map((later) => later.slot)) } : part));
}

const EXCEPT = "*-except:";
/** Holds a map's keys: iteration reaches them, but no member lookup selects them, so get(key) stays precise. */
export const KEY_SLOT = "@key";

export function isWildcardSlot(slot: string): boolean {
  return slot === "*" || slot === KEY_SLOT || slot.startsWith(EXCEPT) || slot.startsWith("append:");
}

function exceptedSlots(slot: string): string[] {
  return slot.startsWith(EXCEPT) ? slot.slice(EXCEPT.length).split(",").map(decodeURIComponent) : [];
}

function exceptSlot(slot: string, later: readonly string[]): string {
  const excepted = [...new Set([...exceptedSlots(slot), ...later.filter((name) => name.startsWith("property:"))])].sort();
  return excepted.length ? `${EXCEPT}${excepted.map(encodeURIComponent).join(",")}` : slot;
}

function propertyParts(property: ts.ObjectLiteralElementLike, resolve: (value: ts.Expression) => StorageFact, callable?: (method: ts.MethodDeclaration) => StorageFact): { slot: string; fact: StorageFact }[] {
  if (ts.isSpreadAssignment(property)) {
    return spreadProperties(resolve(property.expression));
  }
  const name = property.name;
  const key = ts.isComputedPropertyName(name) ? literalKey(name.expression) : name.text;
  const expression = propertyValue(property);
  if (ts.isMethodDeclaration(property) && callable) {
    return [{ slot: key === undefined ? "*" : `property:${key}`, fact: callable(property) }];
  }
  return expression ? [{ slot: key === undefined ? "*" : `property:${key}`, fact: resolve(expression) }] : [];
}

function propertyValue(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isShorthandPropertyAssignment(property)) { return property.name; }
  return ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

function spreadProperties(source: StorageFact): { slot: string; fact: StorageFact }[] {
  const cells = source.cells?.filter((cell) => source.outer.includes(cell.allocation));
  return cells?.length ? cells.map((cell) => ({ slot: cell.slot,
    fact: { outer: cell.origins, reachable: reachableOrigins(cell.origins, source.cells ?? []), cells: source.cells } }))
    : [{ slot: "*", fact: elementFact(source) }];
}

function mapEntries(value: ts.NewExpression, constructor: string | undefined): ts.Expression | undefined {
  const entries = value.arguments?.[0] && unwrapExpression(value.arguments[0]);
  return constructor === "Map" || constructor === "WeakMap" ? entries : undefined;
}

function mapEntryListParts(entries: ts.Expression, resolve: (value: ts.Expression) => StorageFact): { slot: string; fact: StorageFact }[] {
  if (ts.isArrayLiteralExpression(entries)) {
    return entries.elements.flatMap((entry) => mapEntryParts(entry, resolve));
  }
  const pair = iteratedFact(resolve(entries), entries);
  return [{ slot: KEY_SLOT, fact: memberStorageFact(pair, "property:0") }, { slot: "*", fact: memberStorageFact(pair, "property:1") }];
}

function mapEntryParts(entry: ts.Expression, resolve: (value: ts.Expression) => StorageFact): { slot: string; fact: StorageFact }[] {
  const pair = unwrapExpression(entry);
  const [first, value] = ts.isArrayLiteralExpression(pair) ? pair.elements : [];
  if (first && value && !ts.isSpreadElement(first) && !ts.isSpreadElement(value)) {
    const key = literalKey(first);
    return key === undefined ? [{ slot: KEY_SLOT, fact: resolve(first) }, { slot: "*", fact: resolve(value) }]
      : [{ slot: `entry:${key}`, fact: resolve(value) }];
  }
  const fact = resolve(ts.isSpreadElement(pair) ? pair.expression : pair);
  return [{ slot: "*", fact: { ...fact, outer: fact.reachable } }];
}

export function literalKey(value: ts.Expression): string | undefined {
  const key = unwrapExpression(value);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

/** Gives the global a construction resolves to, through const aliases and globalThis, as Map in new M() after const M = Map. */
export function constructorName(value: ts.NewExpression, model: ScopeModel): string | undefined {
  return globalName(unwrapExpression(value.expression), model);
}

/** Gives the storage of a construction; constructor is the resolved global name, or undefined for a local class. */
export function constructorStorageFact(
  value: ts.NewExpression, constructor: string | undefined, resolve: (value: ts.Expression) => StorageFact,
): StorageFact {
  const entries = mapEntries(value, constructor);
  if (constructor === "Set" || constructor === "WeakSet") {
    const iterable = value.arguments?.[0];
    return allocatedFact(value, iterable ? [{ slot: "*", fact: iteratedFact(resolve(iterable), value.expression) }] : []);
  }
  return entries ? allocatedFact(value, mapEntryListParts(entries, resolve))
    : allocatedFact(value, (value.arguments ?? []).flatMap((argument) => {
      const fact = resolve(argument);
      return [{ slot: "*", fact }, { slot: "*", fact: iteratedFact(fact, value.expression) }];
    }));
}

type HeapWrite = { readonly target: StorageFact; readonly value: StorageFact; readonly slot?: string; readonly replace: boolean };

/**
 * Replays heap writes over a fact and keeps the cells its outer storage reaches. A write to an allocation reads only
 * that allocation's cells, so each allocation is replayed on its own and only when the walk from the fact reaches it.
 * The cells keep the order one shared replay would give them: seeded cells by key, then each new cell as it is written.
 */
export function withInsertions(fact: StorageFact, insertions: readonly HeapWrite[]): StorageFact {
  if (insertions.length === 0 || fact.outer.every((origin) => origin === "private" || origin === "unknown")) {
    return fact;
  }
  const relevant = new Set<StorageOrigin>([
    ...fact.outer,
    ...(fact.cells ?? []).flatMap((cell) => [cell.allocation, ...cell.origins]),
  ]);
  if (!insertions.some((insertion) => insertion.target.outer.some((origin) => relevant.has(origin)))) {
    return fact;
  }
  const heap = new ReplayedHeap(fact, insertions);
  const reached = new Set<StorageOrigin>();
  const pending = [...fact.outer];
  const visited = new Set<StorageOrigin>();
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const contents = heap.cellsOf(current);
    const origins = contents.length ? contents.flatMap((cell) => cell.cell.origins) : [current];
    for (const origin of origins) {
      reached.add(origin);
      pending.push(origin);
    }
  }
  const reachableAllocations = new Set<StorageOrigin>([...fact.outer, ...joinOrigins([...reached])]);
  const cells = [...reachableAllocations].flatMap((allocation) => heap.cellsOf(allocation))
    .sort(compareStampedCells).map((stamped) => stamped.cell);
  const reachable = fact.outer.flatMap((origin) => cells.some((cell) => cell.allocation === origin)
    ? reachableOrigins([origin], cells) : fact.reachable);
  return { outer: fact.outer, reachable: joinOrigins(reachable), cells };
}

/** A seeded cell sorts by key, with ties in first-seen order; a written cell sorts by write, target and step. */
type CellStamp = { readonly key: string; readonly first: number } | { readonly write: readonly [number, number, number] };
type StampedCell = { readonly cell: StorageCell; readonly stamp: CellStamp };

function compareStampedCells(left: StampedCell, right: StampedCell): number {
  const a = left.stamp;
  const b = right.stamp;
  if ("key" in a) {
    return "key" in b ? CELL_ORDER.compare(a.key, b.key) || a.first - b.first : -1;
  }
  if ("key" in b) {
    return 1;
  }
  return a.write[0] - b.write[0] || a.write[1] - b.write[1] || a.write[2] - b.write[2];
}

class ReplayedHeap {
  private readonly seeds = new Map<StorageOrigin, { cell: StorageCell; first: number }[]>();
  private readonly writes = new Map<StorageOrigin, { insertion: HeapWrite; index: number; position: number }[]>();
  private readonly replayed = new Map<StorageOrigin, StampedCell[]>();

  constructor(fact: StorageFact, insertions: readonly HeapWrite[]) {
    let first = 0;
    const seed = (cell: StorageCell) => {
      const cells = this.seeds.get(cell.allocation);
      if (cells) {
        cells.push({ cell, first: first++ });
      } else {
        this.seeds.set(cell.allocation, [{ cell, first: first++ }]);
      }
    };
    (fact.cells ?? []).forEach(seed);
    for (const insertion of insertions) {
      (insertion.target.cells ?? []).forEach(seed);
      (insertion.value.cells ?? []).forEach(seed);
    }
    insertions.forEach((insertion, index) => insertion.target.outer.forEach((allocation, position) => {
      if (!isCellAllocation(allocation)) {
        return;
      }
      const writes = this.writes.get(allocation);
      if (writes) {
        writes.push({ insertion, index, position });
      } else {
        this.writes.set(allocation, [{ insertion, index, position }]);
      }
    }));
  }

  cellsOf(allocation: StorageOrigin): readonly StampedCell[] {
    const known = this.replayed.get(allocation);
    if (known) {
      return known;
    }
    const cells = new Map<string, StampedCell>();
    for (const { key, cell, first } of mergeSeededCells(this.seeds.get(allocation) ?? [])) {
      cells.set(key, { cell, stamp: { key, first } });
    }
    for (const { insertion, index, position } of this.writes.get(allocation) ?? []) {
      replayAllocationWrite(cells, allocation, insertion, [index, position]);
    }
    const result = [...cells.values()];
    this.replayed.set(allocation, result);
    return result;
  }
}

/** Merges one allocation's seeded cells as mergeCells does, keeping where each key was first seen. */
function mergeSeededCells(seeds: readonly { cell: StorageCell; first: number }[]): { key: string; cell: StorageCell; first: number }[] {
  const result = new Map<string, { cell: StorageCell; origins: StorageOrigin[]; first: number }>();
  for (const { cell, first } of seeds) {
    const key = cellKey(cell);
    const merged = result.get(key);
    if (merged) {
      merged.cell = cell;
      merged.origins.push(...cell.origins);
    } else {
      result.set(key, { cell, origins: [...cell.origins], first });
    }
  }
  return [...result].sort(([left, a], [right, b]) => CELL_ORDER.compare(left, right) || a.first - b.first)
    .map(([key, { cell, origins, first }]) => ({ key, cell: { ...cell, origins: joinOrigins(origins) }, first }));
}

/** Applies one write to one allocation's cells, as applyHeapWrite and excludeReplacedProperty do on the shared heap. */
function replayAllocationWrite(cells: Map<string, StampedCell>, allocation: StorageOrigin, insertion: HeapWrite, at: readonly [number, number]): void {
  let step = 0;
  const set = (cell: StorageCell) => {
    const key = cellKey(cell);
    cells.set(key, { cell, stamp: cells.get(key)?.stamp ?? { write: [at[0], at[1], step++] } });
  };
  const slot = insertion.slot;
  if (replacesCell(insertion) && slot?.startsWith("property:")) {
    for (const { cell } of [...cells.values()]) {
      if (cell.slot === "*" || cell.slot.startsWith(EXCEPT)) {
        cells.delete(cellKey(cell));
        set({ ...cell, slot: exceptSlot(cell.slot, [slot]) });
      }
    }
  }
  const previous = replacesCell(insertion) ? []
    : allocationMemberOrigins({ ...insertion.target, cells: [...cells.values()].map((stamped) => stamped.cell) }, allocation, slot);
  set({ allocation, slot: slot ?? "*", origins: joinOrigins([...previous, ...insertion.value.outer]) });
}

function applyHeapWrite(heap: CellHeap, insertion: HeapWrite): void {
  for (const allocation of insertion.target.outer.filter(isCellAllocation)) {
    const cell = { allocation, slot: insertion.slot ?? "*", origins: insertion.value.outer };
    if (replacesCell(insertion)) { excludeReplacedProperty(heap, allocation, insertion.slot); }
    const previous = replacesCell(insertion) ? [] : allocationMemberOrigins({ ...insertion.target, cells: heap.cellsOf(allocation) }, allocation, insertion.slot);
    heap.set({ ...cell, origins: joinOrigins([...previous, ...cell.origins]) });
  }
}

function excludeReplacedProperty(heap: CellHeap, allocation: StorageOrigin, slot: string | undefined): void {
  if (!slot?.startsWith("property:")) { return; }
  for (const cell of heap.cellsOf(allocation)) {
    if (cell.slot === "*" || cell.slot.startsWith(EXCEPT)) {
      heap.delete(cell);
      const excluded = { ...cell, slot: exceptSlot(cell.slot, [slot]) };
      heap.set(excluded);
    }
  }
}

function replacesCell(insertion: HeapWrite): boolean {
  return insertion.replace && insertion.target.outer.length === 1 && insertion.slot !== undefined;
}

const SCALAR_TYPE_KINDS = new Set<number>([
  ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword, ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.VoidKeyword, ts.SyntaxKind.NeverKeyword,
]);

export function typedOriginFact(model: ScopeModel, origin: StorageOrigin, type: ts.TypeNode | undefined): StorageFact {
  if (scalarType(type)) {
    return PRIVATE_FACT;
  }
  return { outer: [origin], reachable: scalarElements(model, type) ? ["private"] : [origin] };
}

function scalarType(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return scalarType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every(scalarType);
  }
  return SCALAR_TYPE_KINDS.has(type.kind) || ts.isLiteralTypeNode(type);
}

function scalarElements(model: ScopeModel, type: ts.TypeNode | undefined, seen: ReadonlySet<ts.TypeNode> = new Set()): boolean {
  if (!type || seen.has(type)) {
    return false;
  }
  if (ts.isArrayTypeNode(type)) {
    return scalarType(type.elementType);
  }
  if (ts.isTupleTypeNode(type)) {
    return type.elements.every((element) => scalarType(ts.isNamedTupleMember(element) ? element.type : element));
  }
  if (ts.isTypeOperatorNode(type) || ts.isParenthesizedTypeNode(type)) {
    return scalarElements(model, type.type, new Set(seen).add(type));
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every((part) => scalarElements(model, part, new Set(seen).add(type)));
  }
  return scalarArrayReference(model, type, new Set(seen).add(type));
}

function scalarArrayReference(model: ScopeModel, type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode>): boolean {
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || model.resolve(type.typeName)) {
    return false;
  }
  const local = model.resolveType(type.typeName);
  if (local) {
    return local.kind === "alias" && scalarElements(model, local.type, seen);
  }
  return (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray") && scalarType(type.typeArguments?.[0]);
}

/** The part of a value that an assignment selects: an element, an iterated element, or the name a destructuring pattern binds. */
export type Selection = { readonly element?: boolean; readonly iterated?: boolean; readonly pattern?: ts.Node };

/**
 * Gives the part of the value that an element assignment selects: an iterated element, then each destructuring step.
 * A property step selects the member, a rest step copies the members it keeps, and a default joins its own value.
 */
export function selectedFact(value: StorageFact, selection: Selection, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  if (!selection.element) {
    return value;
  }
  const steps: ts.BindingElement[] = [];
  for (let node = selection.pattern?.parent; node && ts.isBindingElement(node); node = node.parent.parent) {
    steps.unshift(node);
  }
  if (!selection.iterated && steps.length === 0) {
    return elementFact(value);
  }
  const start = selection.iterated && selection.pattern ? iteratedFact(value, selection.pattern) : value;
  return steps.reduce((fact, element) => patternStep(fact, element, resolve), start);
}

export function iteratedFact(value: StorageFact, node: ts.Node): StorageFact {
  return entryCells(value) ? entryPairFact(node, value) : elementFact(value);
}

export function pairsStorageFact(value: ts.Node, pair: ts.Node, source: StorageFact): StorageFact {
  return allocatedFact(value, [{ slot: "*", fact: entryPairFact(pair, source) }]);
}

function entryPairFact(node: ts.Node, source: StorageFact): StorageFact {
  const element = visitedElementFact(source);
  return allocatedFact(node, [{ slot: "property:0", fact: element }, { slot: "property:1", fact: element }]);
}

function patternStep(fact: StorageFact, element: ts.BindingElement, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  const selected = ts.isObjectBindingPattern(element.parent) ? propertyStep(fact, element) : arrayStep(fact, element);
  return element.initializer ? joinFacts(selected, resolve(element.initializer)) : selected;
}

function propertyStep(fact: StorageFact, element: ts.BindingElement): StorageFact {
  if (element.dotDotDotToken) {
    return shallowStorageFact(element.name, fact);
  }
  const key = element.propertyName ?? element.name;
  const name = ts.isComputedPropertyName(key) ? literalKey(key.expression)
    : ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  return memberStorageFact(fact, name === undefined ? undefined : `property:${name}`);
}

function arrayStep(fact: StorageFact, element: ts.BindingElement): StorageFact {
  if (element.dotDotDotToken) {
    return allocatedFact(element.name, [{ slot: "*", fact: iteratedFact(fact, element) }]);
  }
  return entryCells(fact) ? entryPairFact(element.name, fact) : memberStorageFact(fact, `property:${element.parent.elements.indexOf(element)}`);
}

export function visitedElementFact(source: StorageFact): StorageFact {
  return entryCells(source) ? reachedFact(source) : elementFact(source);
}

function entryCells(fact: StorageFact): boolean {
  return !!fact.cells?.some((cell) => fact.outer.includes(cell.allocation) && (cell.slot.startsWith("entry:") || cell.slot === KEY_SLOT));
}

function reachedFact(fact: StorageFact): StorageFact {
  return { outer: fact.reachable, reachable: fact.reachable, cells: fact.cells };
}
