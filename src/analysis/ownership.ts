import ts from "typescript";
import { unwrapExpression } from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import * as assignments from "./assignments";
import { ownerParameters, type EffectOwner } from "./owners";

/**
 * Where storage can come from.
 * Private storage is created by the function. External storage outlives it, as a module or captured binding does.
 * Receiver storage belongs to this. A parameter origin names the argument that supplies the storage.
 * Unknown storage has an origin this analysis does not trace.
 */
export type StorageOrigin = "private" | "unknown" | "external" | "receiver" | `param:${number}` | `external:${number}`;

/** The origins of a value's own storage, and of the storage reachable through its members or elements. */
export type StorageFact = {
  readonly outer: readonly StorageOrigin[];
  readonly reachable: readonly StorageOrigin[];
};

export type StoragePath = "outer" | "reachable";

/** Gives the storage a call returns, or undefined when the call is not resolved. */
export type CallStorageResolver = (
  call: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
  seen: ReadonlySet<Binding>,
) => StorageFact | undefined;

type FactContext = {
  readonly model: ScopeModel;
  readonly owner: EffectOwner;
  readonly site: ts.Node;
  readonly seen: ReadonlySet<Binding>;
  readonly callStorage?: CallStorageResolver;
};

type Handler = (value: ts.Expression, context: FactContext) => StorageFact;

const PRIVATE_FACT: StorageFact = { outer: ["private"], reachable: ["private"] };
const UNKNOWN_FACT: StorageFact = { outer: ["unknown"], reachable: ["unknown"] };
const RECEIVER_FACT: StorageFact = { outer: ["receiver"], reachable: ["receiver"] };

// Standard constructors whose instance is fresh storage that can hold the arguments.
const FRESH_CONSTRUCTORS = new Set([
  "Array", "Date", "Error", "Map", "Object", "RangeError", "RegExp", "Set", "TypeError", "WeakMap", "WeakSet",
]);

// Literals, templates, unary operators, and function or class expressions give a primitive or a fresh value.
const PRIMITIVE_OR_FRESH_KINDS = new Set<number>([
  ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.PostfixUnaryExpression, ts.SyntaxKind.TypeOfExpression,
  ts.SyntaxKind.VoidExpression, ts.SyntaxKind.DeleteExpression, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

const PRIMITIVE_GLOBALS = new Set(["undefined", "NaN", "Infinity"]);

const SCALAR_TYPE_KINDS = new Set<number>([
  ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.SymbolKeyword, ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.VoidKeyword, ts.SyntaxKind.NeverKeyword,
]);

const HANDLERS = new Map<number, Handler>([
  [ts.SyntaxKind.ArrayLiteralExpression, arrayLiteralFact],
  [ts.SyntaxKind.ObjectLiteralExpression, objectLiteralFact],
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
  callStorage?: CallStorageResolver,
): StorageFact {
  if (seen.has(binding)) {
    return UNKNOWN_FACT;
  }
  const context = { model, owner, seen: new Set(seen).add(binding), callStorage };
  let fact = initialFact(binding, owner);
  for (const assignment of assignments.assignmentsBeforeSite(binding, owner, site)) {
    const assigned = assignment.value ? expressionFact(assignment.value, { ...context, site: assignment.node }) : UNKNOWN_FACT;
    const next = assignment.element ? elementFact(assigned) : assigned;
    fact = assignment.join ? joinFacts(fact, next) : next;
  }
  return fact;
}

/** Gives the storage the expression evaluates to at the site in the owner. */
export function expressionStorageFact(
  model: ScopeModel,
  expression: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
  callStorage?: CallStorageResolver,
): StorageFact {
  return expressionFact(expression, { model, owner, site, seen: new Set(), callStorage });
}

/** Gives the storage of an element, member, or iterated item of a value with the fact. */
export function elementFact(fact: StorageFact): StorageFact {
  return { outer: fact.reachable, reachable: fact.reachable };
}

export function originsForPath(fact: StorageFact, path: StoragePath): readonly StorageOrigin[] {
  return path === "outer" ? fact.outer : fact.reachable;
}

export function parameterOriginIndexes(origins: readonly StorageOrigin[]): number[] {
  return origins
    .filter((origin): origin is `param:${number}` => origin.startsWith("param:"))
    .map((origin) => Number(origin.slice("param:".length)));
}

export function hasExternalOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.some((origin) => origin === "external" || origin.startsWith("external:"));
}

export function externalBindingOrigin(binding: Binding): StorageOrigin {
  return `external:${binding.declarations[0].identifier.getStart()}`;
}

export function hasUnknownOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.includes("unknown");
}

export function hasReceiverOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.includes("receiver");
}

export function hasCallerOrigin(origins: readonly StorageOrigin[]): boolean {
  return origins.some((origin) => origin !== "private" && origin !== "unknown");
}

export function joinStorageFacts(facts: readonly StorageFact[]): StorageFact {
  return facts.reduce(joinFacts, PRIVATE_FACT);
}

export function joinStorageOrigins(origins: readonly StorageOrigin[]): readonly StorageOrigin[] {
  return joinOrigins(origins);
}

function initialFact(binding: Binding, owner: EffectOwner): StorageFact {
  const index = ownerParameters(owner).findIndex((parameter) =>
    binding.declarations.some((item) => item.kind === "parameter" && item.node === parameter),
  );
  if (index >= 0) {
    return typedOriginFact(`param:${index}`, ownerParameters(owner)[index].type);
  }
  if (assignments.inside(binding.scope.node, owner)) {
    return PRIVATE_FACT;
  }
  const declaration = binding.declarations.find((item) => ts.isVariableDeclaration(item.node))?.node;
  const type = declaration && ts.isVariableDeclaration(declaration) ? declaration.type : undefined;
  return typedOriginFact(externalBindingOrigin(binding), type);
}

function typedOriginFact(origin: StorageOrigin, type: ts.TypeNode | undefined): StorageFact {
  if (scalarType(type)) {
    return PRIVATE_FACT;
  }
  return { outer: [origin], reachable: scalarElements(type) ? ["private"] : [origin] };
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

function scalarElements(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  if (ts.isArrayTypeNode(type)) {
    return scalarType(type.elementType);
  }
  if (ts.isTupleTypeNode(type)) {
    return type.elements.every((element) => scalarType(ts.isNamedTupleMember(element) ? element.type : element));
  }
  if (ts.isTypeOperatorNode(type) || ts.isParenthesizedTypeNode(type)) {
    return scalarElements(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every(scalarElements);
  }
  return scalarArrayReference(type);
}

function scalarArrayReference(type: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) &&
    (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray") &&
    scalarType(type.typeArguments?.[0]);
}

function expressionFact(expression: ts.Expression, context: FactContext): StorageFact {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    const binding = context.model.resolve(value);
    if (binding) {
      return storageFactAt(context.model, binding, context.owner, context.site, context.seen, context.callStorage);
    }
    return PRIMITIVE_GLOBALS.has(value.text) ? PRIVATE_FACT : UNKNOWN_FACT;
  }
  const handler = HANDLERS.get(value.kind);
  if (handler) {
    return handler(value, context);
  }
  return PRIMITIVE_OR_FRESH_KINDS.has(value.kind) ? PRIVATE_FACT : UNKNOWN_FACT;
}

// A constructor or field initializer builds this in fresh storage. Elsewhere this is the receiver.
function thisFact(value: ts.Expression, context: FactContext): StorageFact {
  const owner = context.owner;
  return ts.isConstructorDeclaration(owner) || ts.isClassLike(owner) ? PRIVATE_FACT : RECEIVER_FACT;
}

function memberFact(value: ts.Expression, context: FactContext): StorageFact {
  return ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)
    ? elementFact(expressionFact(value.expression, context)) : UNKNOWN_FACT;
}

function conditionalFact(value: ts.Expression, context: FactContext): StorageFact {
  return ts.isConditionalExpression(value)
    ? joinFacts(expressionFact(value.whenTrue, context), expressionFact(value.whenFalse, context)) : UNKNOWN_FACT;
}

// Short-circuit operators give either operand. A comma or assignment gives its right operand.
// Other binary operators give a primitive.
function binaryFact(value: ts.Expression, context: FactContext): StorageFact {
  if (!ts.isBinaryExpression(value)) {
    return UNKNOWN_FACT;
  }
  const operator = value.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
    return expressionFact(value.right, context);
  }
  if (assignments.isShortCircuit(operator)) {
    return joinFacts(expressionFact(value.left, context), expressionFact(value.right, context));
  }
  return PRIVATE_FACT;
}

function callFact(value: ts.Expression, context: FactContext): StorageFact {
  return context.callStorage?.(value, context.owner, context.site, context.seen) ?? UNKNOWN_FACT;
}

function arrayLiteralFact(value: ts.Expression, context: FactContext): StorageFact {
  return ts.isArrayLiteralExpression(value) ? freshHolding(value.elements, context) : UNKNOWN_FACT;
}

function objectLiteralFact(value: ts.Expression, context: FactContext): StorageFact {
  if (!ts.isObjectLiteralExpression(value)) {
    return UNKNOWN_FACT;
  }
  const parts = value.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) {
      return [property.expression];
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return [property.name];
    }
    return ts.isPropertyAssignment(property) ? [property.initializer] : [];
  });
  return freshHolding(parts, context);
}

// A known standard or same-file class constructor gives fresh outer storage that can hold its arguments.
function newFact(value: ts.Expression, context: FactContext): StorageFact {
  if (!ts.isNewExpression(value)) {
    return UNKNOWN_FACT;
  }
  return knownConstructor(context.model, unwrapExpression(value.expression))
    ? freshHolding(value.arguments ?? [], context)
    : UNKNOWN_FACT;
}

// Fresh storage holds the parts, so whatever storage the parts hold or reach is reachable through it.
function freshHolding(parts: readonly ts.Expression[], context: FactContext): StorageFact {
  const shared = parts.flatMap((part) => {
    const fact = expressionFact(ts.isSpreadElement(part) ? part.expression : part, context);
    return [...fact.outer, ...fact.reachable];
  });
  return { outer: ["private"], reachable: joinOrigins(shared) };
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

// A constructor that returns a value can give storage other than the fresh instance.
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

function joinFacts(left: StorageFact, right: StorageFact): StorageFact {
  return {
    outer: joinOrigins([...left.outer, ...right.outer]),
    reachable: joinOrigins([...left.reachable, ...right.reachable]),
  };
}

function joinOrigins(origins: readonly StorageOrigin[]): readonly StorageOrigin[] {
  const unique = [...new Set(origins)];
  return unique.length === 0 ? ["private"] : unique.sort();
}
