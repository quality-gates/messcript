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
  readonly insertions: (owner: EffectOwner, site: ts.Node) => readonly StorageInsertion[];
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
  [ts.SyntaxKind.ObjectLiteralExpression, (value, context) => storage.objectLiteralFact(value, (part) => expressionFact(part, context))],
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
  if (seen.has(binding)) {
    return UNKNOWN_FACT;
  }
  const context = { model, owner, seen: new Set(seen).add(binding), resolver };
  let fact = initialFact(model, binding, owner);
  const alias = ambientAlias(binding, owner);
  if (alias) {
    fact = expressionFact(alias, { ...context, site });
  }
  const events = [
    ...assignments.assignmentsBeforeSite(binding, owner, site).map((assignment) => ({
      node: assignment.node, replace: !assignment.join,
      value: assignment.value ? expressionFact(assignment.value, { ...context, site: assignment.node }) : UNKNOWN_FACT,
      element: assignment.element,
    })),
    ...(resolver?.insertions(owner, site) ?? []).filter((insertion) => insertion.kind === "binding" && insertion.binding === binding)
      .map((insertion) => ({ node: insertion.node, replace: insertion.replace, value: insertion.value, element: false })),
  ].sort((left, right) => left.node.end - right.node.end);
  for (const event of events) {
    const next = event.element ? storage.elementFact(event.value) : event.value;
    fact = event.replace ? next : storage.joinFacts(fact, next);
  }
  return insertedFact(fact, { ...context, site });
}

function ambientAlias(binding: Binding, owner: EffectOwner): ts.Expression | undefined {
  if (assignments.inside(binding.scope.node, owner)) {
    return undefined;
  }
  const declaration = binding.declarations.find((item) => ts.isVariableDeclaration(item.node))?.node;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  const value = unwrapExpression(declaration.initializer);
  return ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) ? value : undefined;
}

/** Gives the storage the expression evaluates to at the site in the owner. */
export function expressionStorageFact(
  model: ScopeModel,
  expression: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
  resolver?: StorageResolver,
): StorageFact {
  return expressionFact(expression, { model, owner, site, seen: new Set(), resolver });
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
  if (!ts.isNewExpression(value) || !knownConstructor(context.model, unwrapExpression(value.expression))) {
    return UNKNOWN_FACT;
  }
  return storage.constructorStorageFact(value, (part) => expressionFact(part, context));
}

function insertedFact(fact: StorageFact, context: FactContext): StorageFact {
  const insertions = (context.resolver?.insertions(context.owner, context.site) ?? []).filter((insertion) => insertion.kind === "cell");
  return storage.withInsertions(fact, insertions);
}

function knownConstructor(model: ScopeModel, callee: ts.Expression): boolean {
  if (!ts.isIdentifier(callee)) {
    return false;
  }
  const binding = model.resolve(callee);
  if (!binding) {
    return FRESH_CONSTRUCTORS.has(callee.text);
  }
  const declaration = binding.declarations.length === 1 ? binding.declarations[0] : undefined;
  return declaration?.kind === "class" && !extendsClass(declaration.node) && !returnsFromConstructor(declaration.node);
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
