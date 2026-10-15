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
export type StorageOrigin = "private" | "unknown" | "external" | "receiver" | `private:${number}` | `private:${number}:${string}` | `param:${number}` | `param:${number}:${string}` | `external:${number}` | `external:${number}:${string}`;

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

export function invokedStorageFact(fact: StorageFact, call: ts.CallExpression | ts.NewExpression): StorageFact {
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

function projectedPath(path: readonly string[], slot: string): string {
  if (path.length >= 2 && path[path.length - 1] === "*") {
    return path.map(encodeURIComponent).join("/");
  }
  const next = path.length >= MAX_PROJECTION_DEPTH ? [...path.slice(0, MAX_PROJECTION_DEPTH - 1), "*"] : [...path, slot];
  return next.map(encodeURIComponent).join("/");
}

function projectedOrigin(origin: StorageOrigin, slot: string): StorageOrigin {
  const projection = parameterProjection(origin);
  if (projection) {
    return `param:${projection.parameterIndex}:${projectedPath(projection.path, slot)}`;
  }
  const external = externalProjection(origin);
  return external ? `${external.base}:${projectedPath(external.path, slot)}` : origin;
}

export function hasExternalOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.some((origin) => origin === "external" || origin.startsWith("external:"));
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
  const matched = cells.filter((cell) => cell.slot !== "@allocation" && (cell.slot !== KEY_SLOT || slot === "*") && cellMatchesSlot(cell.slot, slot)).flatMap((cell) => cell.origins);
  return isClosedMemberSlot(cells, slot) ? matched : [...matched, ...projected];
}

function projectedMemberOrigins(fact: StorageFact, allocation: StorageOrigin, slot: string | undefined): readonly StorageOrigin[] {
  const base: readonly StorageOrigin[] = fact.outer.length === 1
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
  const heap = new Map<string, StorageCell>();
  const initial = { allocation, slot: "@allocation", origins: ["private"] } satisfies StorageCell;
  heap.set(cellKey(initial), initial);
  for (const { slot, fact } of parts) {
    for (const cell of fact.cells ?? []) {
      heap.set(cellKey(cell), cell);
    }
    applyHeapWrite(heap, { target: { outer: [allocation], reachable: [] }, value: fact,
      slot, replace: !isWildcardSlot(slot) });
  }
  const cells = pruneCells([allocation], [...heap.values()]);
  return { outer: [allocation], reachable: reachableOrigins([allocation], cells), cells };
}

function reachableOrigins(roots: readonly StorageOrigin[], cells: readonly StorageCell[]): readonly StorageOrigin[] {
  const reached = new Set<StorageOrigin>();
  const pending = [...roots];
  const visited = new Set<StorageOrigin>();
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const contents = cells.filter((cell) => cell.allocation === current);
    const origins = contents.length ? contents.flatMap((cell) => cell.origins) : [current];
    for (const origin of origins) {
      reached.add(origin);
      pending.push(origin);
    }
  }
  return joinOrigins([...reached]);
}

function cellKey(cell: StorageCell): string {
  return `${cell.allocation}/${cell.slot}`;
}

function mergeCells(cells: readonly StorageCell[]): StorageCell[] {
  const result = new Map<string, StorageCell>();
  for (const cell of cells) {
    const origins = joinOrigins([...(result.get(cellKey(cell))?.origins ?? []), ...cell.origins]);
    result.set(cellKey(cell), { ...cell, origins });
  }
  return [...result.values()].sort((left, right) => cellKey(left).localeCompare(cellKey(right)));
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
  return allocatedFact(value, value.elements.map((element, index) => ts.isSpreadElement(element)
    ? { slot: "*", fact: iteratedFact(resolve(element.expression), element) }
    : { slot: `property:${index}`, fact: resolve(element) }));
}

export function objectLiteralFact(value: ts.Expression, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  if (!ts.isObjectLiteralExpression(value)) {
    return { outer: ["unknown"], reachable: ["unknown"] };
  }
  const parts = value.properties.flatMap((property) => propertyParts(property, resolve));
  return allocatedFact(value, parts.map((part, index) => isWildcardSlot(part.slot)
    ? { ...part, slot: exceptSlot(part.slot, parts.slice(index + 1).map((later) => later.slot)) } : part));
}

const EXCEPT = "*-except:";
/** Holds a map's keys: iteration reaches them, but no member lookup selects them, so get(key) stays precise. */
export const KEY_SLOT = "@key";

export function isWildcardSlot(slot: string): boolean {
  return slot === "*" || slot === KEY_SLOT || slot.startsWith(EXCEPT);
}

function exceptedSlots(slot: string): string[] {
  return slot.startsWith(EXCEPT) ? slot.slice(EXCEPT.length).split(",").map(decodeURIComponent) : [];
}

function exceptSlot(slot: string, later: readonly string[]): string {
  const excepted = [...new Set([...exceptedSlots(slot), ...later.filter((name) => name.startsWith("property:"))])].sort();
  return excepted.length ? `${EXCEPT}${excepted.map(encodeURIComponent).join(",")}` : slot;
}

function propertyParts(property: ts.ObjectLiteralElementLike, resolve: (value: ts.Expression) => StorageFact): { slot: string; fact: StorageFact }[] {
  if (ts.isSpreadAssignment(property)) {
    return spreadProperties(resolve(property.expression));
  }
  const name = property.name;
  const key = ts.isComputedPropertyName(name) ? literalKey(name.expression) : name.text;
  const expression = ts.isShorthandPropertyAssignment(property) ? property.name
    : ts.isPropertyAssignment(property) ? property.initializer : undefined;
  return expression ? [{ slot: key === undefined ? "*" : `property:${key}`, fact: resolve(expression) }] : [];
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
  return entries ? allocatedFact(value, mapEntryListParts(entries, resolve))
    : allocatedFact(value, (value.arguments ?? []).flatMap((argument) => {
      const fact = resolve(argument);
      return [{ slot: "*", fact }, { slot: "*", fact: iteratedFact(fact, value.expression) }];
    }));
}

type HeapWrite = { readonly target: StorageFact; readonly value: StorageFact; readonly slot?: string; readonly replace: boolean };

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
  const heap = new Map<string, StorageCell>();
  for (const cell of mergeCells([...(fact.cells ?? []), ...insertions.flatMap((insertion) => [
    ...(insertion.target.cells ?? []), ...(insertion.value.cells ?? []),
  ])])) {
    heap.set(cellKey(cell), cell);
  }
  for (const insertion of insertions) {
    applyHeapWrite(heap, insertion);
  }
  const allCells = [...heap.values()];
  const reachableAllocations = new Set<StorageOrigin>(fact.outer);
  for (const origin of reachableOrigins(fact.outer, allCells)) {
    reachableAllocations.add(origin);
  }
  const cells = allCells.filter((cell) => reachableAllocations.has(cell.allocation));
  const reachable = fact.outer.flatMap((origin) => cells.some((cell) => cell.allocation === origin)
    ? reachableOrigins([origin], cells) : fact.reachable);
  return { outer: fact.outer, reachable: joinOrigins(reachable), cells };
}

function applyHeapWrite(heap: Map<string, StorageCell>, insertion: HeapWrite): void {
  for (const allocation of insertion.target.outer.filter(isCellAllocation)) {
    const cell = { allocation, slot: insertion.slot ?? "*", origins: insertion.value.outer };
    const previous = replacesCell(insertion) ? [] : heap.get(cellKey(cell))?.origins ?? [];
    heap.set(cellKey(cell), { ...cell, origins: joinOrigins([...previous, ...cell.origins]) });
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

export function pairsStorageFact(value: ts.CallExpression, pair: ts.Node, source: StorageFact): StorageFact {
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
