import ts from "typescript";
import { isFunctionLike, type FunctionLike } from "../ast/functions";
import { unwrapExpression } from "../ast/expressions";
import type { Binding, ScopeModel } from "../ast/scopes";
import { assignmentsBeforeSite, inside, isShortCircuit } from "./assignments";

/**
 * Where storage can come from.
 * Private storage is created by the function. External storage outlives it, as a module or captured binding does.
 * Receiver storage belongs to this. A parameter origin names the argument that supplies the storage.
 * Unknown storage has an origin this analysis does not trace.
 */
export type StorageOrigin = "private" | "unknown" | "external" | "receiver" | `param:${number}`;

/** The origins of a value's own storage, and of the storage reachable through its members or elements. */
export type StorageFact = {
  readonly outer: readonly StorageOrigin[];
  readonly reachable: readonly StorageOrigin[];
};

export type StoragePath = "outer" | "reachable";

/** Gives the storage a call returns, or undefined when the call is not resolved. */
export type CallStorageResolver = (
  call: ts.Expression,
  owner: FunctionLike,
  site: ts.Node,
  seen: ReadonlySet<Binding>,
) => StorageFact | undefined;

type FactContext = {
  readonly model: ScopeModel;
  readonly owner: FunctionLike;
  readonly site: ts.Node;
  readonly seen: ReadonlySet<Binding>;
  readonly callStorage?: CallStorageResolver;
};

type Handler = (value: ts.Expression, context: FactContext) => StorageFact;

type MemberShape = { readonly expression: ts.Expression };
type ConditionalShape = { readonly whenTrue: ts.Expression; readonly whenFalse: ts.Expression };
type BinaryShape = { readonly left: ts.Expression; readonly right: ts.Expression; readonly operatorToken: ts.Node };
type ElementsShape = { readonly elements: readonly ts.Expression[] };
type PropertiesShape = { readonly properties: readonly ts.Node[] };
type NewShape = { readonly expression: ts.Expression; readonly arguments?: readonly ts.Expression[] };

const PRIVATE_FACT: StorageFact = { outer: ["private"], reachable: ["private"] };
const UNKNOWN_FACT: StorageFact = { outer: ["unknown"], reachable: ["unknown"] };
const EXTERNAL_FACT: StorageFact = { outer: ["external"], reachable: ["external"] };
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
  owner: FunctionLike,
  site: ts.Node,
  seen: ReadonlySet<Binding> = new Set(),
  callStorage?: CallStorageResolver,
): StorageFact {
  if (seen.has(binding)) {
    return UNKNOWN_FACT;
  }
  const context = { model, owner, seen: new Set(seen).add(binding), callStorage };
  let fact = initialFact(binding, owner);
  for (const assignment of assignmentsBeforeSite(binding, owner, site)) {
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
  owner: FunctionLike,
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
  return origins.includes("external");
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

function initialFact(binding: Binding, owner: FunctionLike): StorageFact {
  const index = owner.parameters.findIndex((parameter) =>
    binding.declarations.some((item) => item.kind === "parameter" && item.node === parameter),
  );
  if (index >= 0) {
    const origin = `param:${index}` as const;
    return { outer: [origin], reachable: [origin] };
  }
  return inside(binding.scope.node, owner) ? PRIVATE_FACT : EXTERNAL_FACT;
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

// A constructor builds this in fresh storage. Elsewhere this is the receiver.
function thisFact(value: ts.Expression, context: FactContext): StorageFact {
  return ts.isConstructorDeclaration(context.owner) ? PRIVATE_FACT : RECEIVER_FACT;
}

function memberFact(value: ts.Expression, context: FactContext): StorageFact {
  return elementFact(expressionFact((value as unknown as MemberShape).expression, context));
}

function conditionalFact(value: ts.Expression, context: FactContext): StorageFact {
  const conditional = value as unknown as ConditionalShape;
  return joinFacts(expressionFact(conditional.whenTrue, context), expressionFact(conditional.whenFalse, context));
}

// Short-circuit operators give either operand. A comma or assignment gives its right operand.
// Other binary operators give a primitive.
function binaryFact(value: ts.Expression, context: FactContext): StorageFact {
  const binary = value as unknown as BinaryShape;
  const operator = binary.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
    return expressionFact(binary.right, context);
  }
  if (isShortCircuit(operator)) {
    return joinFacts(expressionFact(binary.left, context), expressionFact(binary.right, context));
  }
  return PRIVATE_FACT;
}

function callFact(value: ts.Expression, context: FactContext): StorageFact {
  return context.callStorage?.(value, context.owner, context.site, context.seen) ?? UNKNOWN_FACT;
}

function arrayLiteralFact(value: ts.Expression, context: FactContext): StorageFact {
  return freshHolding((value as unknown as ElementsShape).elements, context);
}

function objectLiteralFact(value: ts.Expression, context: FactContext): StorageFact {
  const parts = (value as unknown as PropertiesShape).properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) {
      return [property.expression];
    }
    return ts.isPropertyAssignment(property) ? [property.initializer] : [];
  });
  return freshHolding(parts, context);
}

// A known standard or same-file class constructor gives fresh outer storage that can hold its arguments.
function newFact(value: ts.Expression, context: FactContext): StorageFact {
  const created = value as unknown as NewShape;
  return knownConstructor(context.model, unwrapExpression(created.expression))
    ? freshHolding(created.arguments ?? [], context)
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
    } else if (!isFunctionLike(child)) {
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
