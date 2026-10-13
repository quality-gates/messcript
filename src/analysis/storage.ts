import ts from "typescript";
import type { ScopeModel } from "../ast/scopes";
import { unwrapExpression } from "../ast/expressions";

/**
 * Where storage can come from.
 * Private storage is created by the function. External storage outlives it, as a module or captured binding does.
 * Receiver storage belongs to this. A parameter origin names the argument that supplies the storage.
 * Unknown storage has an origin this analysis does not trace.
 */
export type StorageOrigin = "private" | "unknown" | "external" | "receiver" | `private:${number}` | `private:${number}:${string}` | `param:${number}` | `param:${number}:${string}` | `external:${number}`;

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

export function invokedStorageFact(fact: StorageFact, call: ts.CallExpression): StorageFact {
  const rebase = (origins: readonly StorageOrigin[]) => joinOrigins(origins.map((origin) => invocationOrigin(origin, call.getStart())));
  return mapStorageFact(fact, rebase, rebase);
}

function invocationOrigin(origin: StorageOrigin, site: number): StorageOrigin {
  if (!origin.startsWith("private:")) {
    return origin;
  }
  const [, allocation, context = ""] = origin.split(":");
  const calls = new Set(context.split(",").filter((value) => value.length > 0));
  calls.add(String(site));
  return `private:${Number(allocation)}:${[...calls].sort().join(",")}`;
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

function projectedOrigin(origin: StorageOrigin, slot: string): StorageOrigin {
  const projection = parameterProjection(origin);
  return projection
    ? `param:${projection.parameterIndex}:${[...projection.path, slot].map(encodeURIComponent).join("/")}`
    : origin;
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
  const origins = fact.outer.flatMap((allocation) => {
    const cells = fact.cells?.filter((cell) => cell.allocation === allocation);
    return cells?.length ? cells.filter((cell) => cell.slot !== "@allocation" && (slot === undefined || slot === "*" || cell.slot === slot || cell.slot === "*")).flatMap((cell) => cell.origins)
      : fact.reachable.map((origin) => projectedOrigin(origin, slot ?? "*"));
  });
  const outer = joinOrigins(origins);
  return { outer, reachable: reachableOrigins(outer, fact.cells ?? []), cells: fact.cells };
}

export function mapStorageFact(
  fact: StorageFact,
  outer: (origins: readonly StorageOrigin[]) => readonly StorageOrigin[],
  reachable: (origins: readonly StorageOrigin[]) => readonly StorageOrigin[],
  imported: readonly StorageCell[] = [],
): StorageFact {
  return { outer: outer(fact.outer), reachable: reachable(fact.reachable), cells: mergeCells([
    ...(fact.cells ?? []).flatMap((cell) => outer([cell.allocation]).map((allocation) => ({
      allocation, slot: cell.slot, origins: outer(cell.origins),
    }))), ...imported,
  ]) };
}

export function allocatedFact(value: ts.Expression, parts: readonly { slot: string; fact: StorageFact }[]): StorageFact {
  const allocation: StorageOrigin = `private:${value.getStart()}`;
  const heap = new Map<string, StorageCell>();
  const initial = { allocation, slot: "@allocation", origins: ["private"] } satisfies StorageCell;
  heap.set(cellKey(initial), initial);
  for (const { slot, fact } of parts) {
    for (const cell of fact.cells ?? []) {
      heap.set(cellKey(cell), cell);
    }
    applyHeapWrite(heap, { target: { outer: [allocation], reachable: [] }, value: fact,
      slot, replace: slot !== "*" });
  }
  const cells = [...heap.values()];
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

export function joinFacts(left: StorageFact, right: StorageFact): StorageFact {
  return {
    outer: joinOrigins([...left.outer, ...right.outer]),
    reachable: joinOrigins([...left.reachable, ...right.reachable]),
    cells: mergeCells([...(left.cells ?? []), ...(right.cells ?? [])]),
  };
}

export function joinOrigins(origins: readonly StorageOrigin[]): readonly StorageOrigin[] {
  const unique = [...new Set(origins)];
  return unique.length === 0 ? ["private"] : unique.sort();
}

export function shallowStorageFact(value: ts.Expression, source: StorageFact): StorageFact {
  const cells = source.cells?.filter((cell) => source.outer.includes(cell.allocation));
  return cells?.length ? allocatedFact(value, cells.map((cell) => ({ slot: cell.slot,
    fact: { outer: cell.origins, reachable: reachableOrigins(cell.origins, source.cells ?? []), cells: source.cells } })))
    : allocatedFact(value, [{ slot: "*", fact: { outer: source.reachable, reachable: source.reachable, cells: source.cells } }]);
}

export function arrayLiteralFact(value: ts.Expression, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  if (!ts.isArrayLiteralExpression(value)) {
    return { outer: ["unknown"], reachable: ["unknown"] };
  }
  const only = value.elements.length === 1 ? value.elements[0] : undefined;
  if (only && ts.isSpreadElement(only)) {
    return shallowStorageFact(value, resolve(only.expression));
  }
  return allocatedFact(value, value.elements.map((element, index) => ts.isSpreadElement(element)
    ? { slot: "*", fact: elementFact(resolve(element.expression)) }
    : { slot: `property:${index}`, fact: resolve(element) }));
}

export function objectLiteralFact(value: ts.Expression, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  if (!ts.isObjectLiteralExpression(value)) {
    return { outer: ["unknown"], reachable: ["unknown"] };
  }
  return allocatedFact(value, value.properties.flatMap((property) => propertyParts(property, resolve)));
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

function mapEntries(value: ts.NewExpression): ts.ArrayLiteralExpression | undefined {
  const name = unwrapExpression(value.expression);
  const entries = value.arguments?.[0] && unwrapExpression(value.arguments[0]);
  return ts.isIdentifier(name) && (name.text === "Map" || name.text === "WeakMap") && entries && ts.isArrayLiteralExpression(entries)
    ? entries : undefined;
}

function mapEntryParts(entry: ts.Expression, resolve: (value: ts.Expression) => StorageFact): { slot: string; fact: StorageFact }[] {
  const pair = unwrapExpression(entry);
  if (!ts.isArrayLiteralExpression(pair) || !pair.elements[1]) {
    return [];
  }
  const key = literalKey(pair.elements[0]);
  return [{ slot: key === undefined ? "*" : `entry:${key}`, fact: resolve(pair.elements[1]) }];
}

export function literalKey(value: ts.Expression): string | undefined {
  const key = unwrapExpression(value);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

export function constructorStorageFact(value: ts.NewExpression, resolve: (value: ts.Expression) => StorageFact): StorageFact {
  const entries = mapEntries(value);
  return entries ? allocatedFact(value, entries.elements.flatMap((entry) => mapEntryParts(entry, resolve)))
    : allocatedFact(value, (value.arguments ?? []).map((argument) => ({ slot: "*", fact: resolve(argument) })));
}

type HeapWrite = { readonly target: StorageFact; readonly value: StorageFact; readonly slot?: string; readonly replace: boolean };

export function withInsertions(fact: StorageFact, insertions: readonly HeapWrite[]): StorageFact {
  const heap = new Map<string, StorageCell>();
  for (const cell of mergeCells([...(fact.cells ?? []), ...insertions.flatMap((insertion) => [
    ...(insertion.target.cells ?? []), ...(insertion.value.cells ?? []),
  ])])) {
    heap.set(cellKey(cell), cell);
  }
  for (const insertion of insertions) {
    applyHeapWrite(heap, insertion);
  }
  const cells = [...heap.values()];
  const reachable = fact.outer.flatMap((origin) => cells.some((cell) => cell.allocation === origin)
    ? reachableOrigins([origin], cells) : fact.reachable);
  return { outer: fact.outer, reachable: joinOrigins(reachable), cells };
}

function applyHeapWrite(heap: Map<string, StorageCell>, insertion: HeapWrite): void {
  for (const allocation of insertion.target.outer) {
    const cell = { allocation, slot: insertion.slot ?? "*", origins: insertion.value.outer };
    const previous = insertion.replace && insertion.target.outer.length === 1 && insertion.slot !== undefined
      ? [] : heap.get(cellKey(cell))?.origins ?? [];
    heap.set(cellKey(cell), { ...cell, origins: joinOrigins([...previous, ...cell.origins]) });
  }
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
