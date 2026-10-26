import * as storage from "./storage";
import { type StorageFact } from "./storage";
import ts from "typescript";
import { unwrapExpression } from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import { ownerParameters, type EffectOwner } from "./owners";

/** Gives the storage a call returns, or undefined when the call is not resolved. */
export type CallStorageResolver = (
  call: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
  seen: ReadonlySet<Binding>,
) => StorageFact | undefined;

export type StorageInsertion = ({ readonly kind: "cell" } | { readonly kind: "binding"; readonly binding: Binding }) & {
  readonly node: ts.Node;
  readonly origin: ts.Node;
  readonly target: StorageFact;
  readonly value: StorageFact;
  readonly slot?: string;
  readonly appendCall?: ts.CallExpression;
  readonly replace: boolean;
};

export type StorageResolver = {
  readonly call: CallStorageResolver;
  /** Tells whether the constructor expression certainly names its declared class, so no decorator or reassignment replaces it. */
  readonly certainClass: (callee: ts.Expression) => boolean;
  readonly binding?: (binding: Binding, owner: EffectOwner, site: ts.Node) => StorageFact | undefined;
  readonly callable?: Parameters<typeof storage.objectLiteralFact>[2];
  readonly value?: (expression: ts.Expression, owner: EffectOwner, site: ts.Node) => StorageFact | undefined;
  readonly insertions: (owner: EffectOwner, site: ts.Node) => readonly StorageInsertion[];
  readonly cache?: Map<string, StorageFact>;
  readonly cycles?: { count: number };
};

type FactContext = {
  readonly model: ScopeModel;
  readonly owner: EffectOwner;
  readonly site: ts.Node;
  readonly seen: ReadonlySet<Binding>;
  readonly resolver?: StorageResolver;
};

type Handler = (value: ts.Expression, context: FactContext) => StorageFact;

const PRIVATE_FACT: StorageFact = { outer: ["private"], reachable: ["private"] };
const UNKNOWN_FACT: StorageFact = { outer: ["unknown"], reachable: ["unknown"] };
const RECEIVER_FACT: StorageFact = { outer: ["receiver"], reachable: ["receiver"] };

const FRESH_CONSTRUCTORS = new Set([
  "Array", "Date", "Error", "Map", "Object", "RangeError", "RegExp", "Set", "TypeError", "WeakMap", "WeakSet",
]);

const PRIMITIVE_OR_FRESH_KINDS = new Set<number>([
  ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.PostfixUnaryExpression, ts.SyntaxKind.TypeOfExpression,
  ts.SyntaxKind.VoidExpression, ts.SyntaxKind.DeleteExpression, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

const PRIMITIVE_GLOBALS = new Set(["undefined", "NaN", "Infinity"]);

const HANDLERS = new Map<number, Handler>([
  [ts.SyntaxKind.ArrayLiteralExpression, (value, context) => storage.arrayLiteralFact(value, (part) => expressionFact(part, context))],
  [ts.SyntaxKind.ObjectLiteralExpression, (value, context) => storage.objectLiteralFact(value, (part) => expressionFact(part, context), context.resolver?.callable)],
  [ts.SyntaxKind.ThisKeyword, thisFact],
  [ts.SyntaxKind.PropertyAccessExpression, memberFact],
  [ts.SyntaxKind.ElementAccessExpression, memberFact],
  [ts.SyntaxKind.ConditionalExpression, conditionalFact],
  [ts.SyntaxKind.BinaryExpression, binaryFact],
  [ts.SyntaxKind.CallExpression, callFact],
  [ts.SyntaxKind.NewExpression, newFact],
]);

/** Gives the storage the binding holds at the site in the owner. */
export function storageFactAt(
  model: ScopeModel,
  binding: Binding,
  owner: EffectOwner,
  site: ts.Node,
  seen: ReadonlySet<Binding> = new Set(),
  resolver?: StorageResolver,
): StorageFact {
  const resolved = resolver?.binding?.(binding, owner, site);
  if (resolved) {
    return insertedFact(resolved, { model, owner, site, seen, resolver });
  }
  const cached = cachedBindingFact(binding, owner, site, resolver);
  if (cached) {
    return cached;
  }
  if (seen.has(binding)) {
    return recordCycle(resolver);
  }
  const beforeCycle = cycleCount(resolver);
  const context = { model, owner, seen: new Set(seen).add(binding), resolver };
  let fact = initialFact(model, binding, owner);
  fact = ambientBindingFact(binding, { ...context, site }, fact);
  fact = replayBindingEvents(binding, { ...context, site }, fact);
  return cacheBindingFact(binding, owner, site, resolver, beforeCycle, insertedFact(fact, { ...context, site }));
}

function replayBindingEvents(binding: Binding, context: FactContext, fact: StorageFact): StorageFact {
  const { owner, site, resolver } = context;
  const events = [
    ...assignments.assignmentsBeforeSite(binding, owner, site).map((assignment) => ({
      node: assignment.node, replace: !assignment.join,
      value: assignment.value ? expressionFact(assignment.value, { ...context, site: assignment.node }) : UNKNOWN_FACT,
      element: assignment.element,
      iterated: assignment.iterated,
      pattern: assignment.pattern,
      context: { ...context, site: assignment.node },
    })),
    ...(resolver?.insertions(owner, site) ?? []).filter((insertion) => insertion.kind === "binding" && insertion.binding === binding)
      .map((insertion) => ({ node: insertion.node, replace: insertion.replace, value: insertion.value, element: false, iterated: false, pattern: undefined, context: { ...context, site } })),
  ].sort((left, right) => left.node.end - right.node.end);
  for (const event of events) {
    const next = storage.selectedFact(event.value, event, (part) => expressionFact(part, event.context));
    fact = event.replace ? next : storage.joinFacts(fact, next);
  }
  return fact;
}

function ambientBindingFact(binding: Binding, context: FactContext, initial: StorageFact): StorageFact {
  const base = externalBindingOrigin(binding);
  const contents = initial.reachable.includes(base) ? assignments.ambientContents(binding, context.owner, context.model) : undefined;
  const fresh = contents && expressionFact(contents.value, context);
  if (fresh?.outer.every((origin) => origin.startsWith("private:"))) {
    return storage.joinFacts(initial, storage.rebasedFact(fresh, base));
  }
  const alias = assignments.ambientAlias(binding, context.owner);
  if (!alias) { return initial; }
  const resolve = (part: ts.Expression): StorageFact => expressionFact(part, context);
  const fact = storage.selectedFact(resolve(alias.value), alias, resolve);
  return ts.isVariableDeclaration(alias.node) && !(alias.node.parent.flags & ts.NodeFlags.Const) &&
    fact.outer.some((origin) => origin.startsWith("host:")) ? initial : fact;
}

export function nodeKey(node: ts.Node): string {
  return `${node.kind}.${node.pos}.${node.end}`;
}

function bindingCacheKey(binding: Binding, owner: EffectOwner, site: ts.Node): string {
  return `b:${binding.declarations[0].identifier.getStart()}:${nodeKey(owner)}:${nodeKey(site)}`;
}

function cachedBindingFact(binding: Binding, owner: EffectOwner, site: ts.Node, resolver?: StorageResolver): StorageFact | undefined {
  return resolver?.cache?.get(bindingCacheKey(binding, owner, site));
}

function cycleCount(resolver?: StorageResolver): number {
  return resolver?.cycles ? resolver.cycles.count : 0;
}

function recordCycle(resolver?: StorageResolver): StorageFact {
  if (resolver?.cycles) {
    resolver.cycles.count += 1;
  }
  return UNKNOWN_FACT;
}

function cacheBindingFact(
  binding: Binding, owner: EffectOwner, site: ts.Node, resolver: StorageResolver | undefined, before: number, result: StorageFact,
): StorageFact {
  if (cycleCount(resolver) === before) {
    resolver?.cache?.set(bindingCacheKey(binding, owner, site), result);
  }
  return result;
}

/** Gives the storage the expression evaluates to at the site in the owner. */
export function expressionStorageFact(
  model: ScopeModel,
  expression: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
  resolver?: StorageResolver,
  seen: ReadonlySet<Binding> = new Set(),
): StorageFact {
  return expressionFact(expression, { model, owner, site, seen, resolver });
}

export function externalBindingOrigin(binding: Binding): `external:${number}` {
  return `external:${binding.declarations[0].identifier.getStart()}`;
}

function initialFact(model: ScopeModel, binding: Binding, owner: EffectOwner): StorageFact {
  const index = ownerParameters(owner).findIndex((parameter) =>
    binding.declarations.some((item) => item.kind === "parameter" && item.node === parameter),
  );
  if (index >= 0) {
    return storage.typedOriginFact(model, `param:${index}`, ownerParameters(owner)[index].type);
  }
  if (assignments.inside(binding.scope.node, owner)) {
    return PRIVATE_FACT;
  }
  const declaration = binding.declarations.find((item) => ts.isVariableDeclaration(item.node))?.node;
  const type = declaration && ts.isVariableDeclaration(declaration) ? declaration.type : undefined;
  return storage.typedOriginFact(model, externalBindingOrigin(binding), type);
}

function expressionFact(expression: ts.Expression, context: FactContext): StorageFact {
  const value = unwrapExpression(expression);
  const resolved = context.resolver?.value?.(value, context.owner, context.site);
  if (resolved) {
    return insertedFact(resolved, context);
  }
  if (ts.isIdentifier(value)) {
    const binding = context.model.resolve(value);
    if (binding) {
      return storageFactAt(context.model, binding, context.owner, context.site, context.seen, context.resolver);
    }
    return PRIMITIVE_GLOBALS.has(value.text) ? PRIVATE_FACT : UNKNOWN_FACT;
  }
  const handler = HANDLERS.get(value.kind);
  if (handler) {
    return insertedFact(handler(value, context), context);
  }
  return PRIMITIVE_OR_FRESH_KINDS.has(value.kind) ? PRIVATE_FACT : UNKNOWN_FACT;
}

function thisFact(value: ts.Expression, context: FactContext): StorageFact {
  const owner = context.owner;
  return ts.isConstructorDeclaration(owner) || ts.isClassLike(owner) ? PRIVATE_FACT : RECEIVER_FACT;
}

function memberFact(value: ts.Expression, context: FactContext): StorageFact {
  if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) {
    return UNKNOWN_FACT;
  }
  const key = ts.isPropertyAccessExpression(value) ? value.name.text : storage.literalKey(value.argumentExpression);
  return storage.memberStorageFact(expressionFact(value.expression, context), key === undefined ? undefined : `property:${key}`);
}

function conditionalFact(value: ts.Expression, context: FactContext): StorageFact {
  return ts.isConditionalExpression(value)
    ? storage.joinFacts(expressionFact(value.whenTrue, context), expressionFact(value.whenFalse, context)) : UNKNOWN_FACT;
}

function binaryFact(value: ts.Expression, context: FactContext): StorageFact {
  if (!ts.isBinaryExpression(value)) {
    return UNKNOWN_FACT;
  }
  const operator = value.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
    return expressionFact(value.right, context);
  }
  if (assignments.isShortCircuit(operator)) {
    return storage.joinFacts(expressionFact(value.left, context), expressionFact(value.right, context));
  }
  return PRIVATE_FACT;
}

function callFact(value: ts.Expression, context: FactContext): StorageFact {
  return context.resolver?.call(value, context.owner, context.site, context.seen) ?? UNKNOWN_FACT;
}

function newFact(value: ts.Expression, context: FactContext): StorageFact {
  if (!ts.isNewExpression(value)) {
    return UNKNOWN_FACT;
  }
  const callee = unwrapExpression(value.expression);
  const global = storage.constructorName(value, context.model);
  if (global === undefined ? !localConstructor(callee, context) : !FRESH_CONSTRUCTORS.has(global)) {
    return UNKNOWN_FACT;
  }
  return storage.constructorStorageFact(value, global, (part) => expressionFact(part, context));
}

function insertedFact(fact: StorageFact, context: FactContext): StorageFact {
  const insertions = (context.resolver?.insertions(context.owner, context.site) ?? []).filter((insertion) => insertion.kind === "cell");
  return storage.withInsertions(fact, insertions);
}

function localConstructor(callee: ts.Expression, context: FactContext): boolean {
  const binding = ts.isIdentifier(callee) ? context.model.resolve(callee) : undefined;
  const declaration = binding?.declarations.length === 1 ? binding.declarations[0] : undefined;
  return declaration?.kind === "class" && certainClass(callee, context.resolver) && !extendsClass(declaration.node) && !returnsFromConstructor(declaration.node);
}

function certainClass(callee: ts.Expression, resolver?: StorageResolver): boolean {
  return resolver ? resolver.certainClass(callee) : false;
}

function extendsClass(node: ts.Node): boolean {
  return !ts.isClassLike(node) ||
    (node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? false);
}

function returnsFromConstructor(node: ts.Node): boolean {
  const constructor = ts.isClassLike(node) ? node.members.find(ts.isConstructorDeclaration) : undefined;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isReturnStatement(child) && child.expression) {
      found = true;
    } else if (!ts.isFunctionLike(child)) {
      ts.forEachChild(child, visit);
    }
  };
  if (constructor?.body) {
    ts.forEachChild(constructor.body, visit);
  }
  return found;
}
