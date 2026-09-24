// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { isFunctionLike } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";

export type ImplicitFlowKind = "input" | "output";

export type ImplicitFlow = {
  kind: ImplicitFlowKind;
  node: ts.Node;
  functionNode: FunctionLike;
  description: string;
};

type Binding = {
  scope: ts.Node;
  parameterOf?: FunctionLike;
  mutated: boolean;
};

type Write = {
  viaCall: boolean;
  reassign: boolean;
  compound: boolean;
};

type Analysis = {
  scopes: Map<ts.Node, Map<string, Binding>>;
  writes: Map<ts.Node, Write>;
};

// Ambient objects that hold host state. A read is an input and a write is an output.
const hostObjects = new Set([
  "document", "globalThis", "localStorage", "location", "navigator", "process", "self", "sessionStorage", "window",
]);

// Names of the global object. A sink is also reached through them, as in window.alert().
const globalObjects = new Set(["globalThis", "self", "window"]);

// Ambient functions and objects that only send data out of the function.
const outputSinks = new Set([
  "alert", "console", "fetch", "queueMicrotask", "requestAnimationFrame", "setInterval", "setTimeout",
]);

// Ambient calls that give a different result on each call.
const nondeterministicCalls = new Set([
  "Date.now", "Math.random", "crypto.getRandomValues", "crypto.randomUUID", "performance.now",
]);

const mutatingMethods = new Set([
  "add", "append", "appendChild", "clear", "copyWithin", "delete", "fill", "insertBefore", "pop", "prepend", "push",
  "remove", "removeAttribute", "removeChild", "removeItem", "replaceChildren", "reverse", "set", "setAttribute",
  "setItem", "shift", "sort", "splice", "unshift", "write", "writeln",
]);

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingIdentifiers(element.name) : []));
}

function isBlockScope(node: ts.Node): boolean {
  return ts.isBlock(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
    ts.isCaseBlock(node) || isFunctionScope(node);
}

function isFunctionScope(node: ts.Node): boolean {
  return isFunctionLike(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isClassStaticBlockDeclaration(node);
}

function nearestScope(node: ts.Node, accepts: (candidate: ts.Node) => boolean): ts.Node {
  let current = node.parent;
  while (!accepts(current)) {
    current = current.parent;
  }
  return current;
}

function declare(analysis: Analysis, scope: ts.Node, names: readonly ts.Identifier[], parameterOf?: FunctionLike): void {
  const bindings = analysis.scopes.get(scope) ?? new Map<string, Binding>();
  for (const name of names) {
    bindings.set(name.text, { scope, parameterOf, mutated: false });
  }
  analysis.scopes.set(scope, bindings);
}

function variableScope(node: ts.VariableDeclaration): ts.Node {
  if (ts.isCatchClause(node.parent)) {
    return node.parent;
  }
  const blockScoped = (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
  return nearestScope(node, blockScoped ? isBlockScope : isFunctionScope);
}

// messcript-disable-next-line CyclomaticComplexity
function declareNamed(analysis: Analysis, node: ts.Node): void {
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
    declare(analysis, node, [node.name]);
    return;
  }
  const declaration = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) ||
    ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node);
  if (declaration && node.name) {
    declare(analysis, nearestScope(node, isBlockScope), [node.name]);
  }
}

function collectDeclarations(analysis: Analysis, node: ts.Node): void {
  if (ts.isVariableDeclaration(node)) {
    declare(analysis, variableScope(node), bindingIdentifiers(node.name));
  } else if (ts.isParameter(node) && isFunctionLike(node.parent)) {
    declare(analysis, node.parent, bindingIdentifiers(node.name), node.parent);
  } else {
    declareNamed(analysis, node);
  }
  ts.forEachChild(node, (child) => collectDeclarations(analysis, child));
}

function resolve(analysis: Analysis, identifier: ts.Identifier): Binding | undefined {
  for (let current = identifier.parent; current; current = current.parent) {
    const binding = analysis.scopes.get(current)?.get(identifier.text);
    if (binding) {
      return binding;
    }
  }
  return undefined;
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function assignmentTargets(node: ts.Expression): ts.Expression[] {
  const target = unwrap(node);
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) => assignmentTargets(ts.isSpreadElement(element) ? element.expression : element));
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name];
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargets(property.initializer);
      }
      return ts.isSpreadAssignment(property) ? assignmentTargets(property.expression) : [];
    });
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargets(target.left);
  }
  return ts.isOmittedExpression(target) ? [] : [target];
}

function isLoopUpdateWrite(target: ts.Node, binding: Binding): boolean {
  if (!ts.isForStatement(binding.scope) || !binding.scope.incrementor) {
    return false;
  }
  const incrementor = binding.scope.incrementor;
  if (!isInside(target, incrementor)) {
    return false;
  }
  for (let current: ts.Node | undefined = target; current && current !== incrementor; current = current.parent) {
    if (isFunctionLike(current)) {
      return false;
    }
  }
  return true;
}

function markMutated(analysis: Analysis, current: ts.Identifier): void {
  const binding = resolve(analysis, current);
  if (binding && !isLoopUpdateWrite(current, binding)) {
    binding.mutated = true;
  }
}

// messcript-disable-next-line CyclomaticComplexity
function recordWrite(analysis: Analysis, target: ts.Expression, contentsOnly: boolean, compound: boolean): void {
  let current = unwrap(target);
  const reassign = !contentsOnly && ts.isIdentifier(current);
  let viaCall = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current)) {
    viaCall ||= ts.isCallExpression(current);
    current = unwrap(current.expression);
  }
  if (!ts.isIdentifier(current) && current.kind !== ts.SyntaxKind.ThisKeyword) {
    return;
  }
  analysis.writes.set(current, { viaCall, reassign, compound });
  if (ts.isIdentifier(current) && !viaCall) {
    markMutated(analysis, current);
  }
}

function methodName(callee: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  const argument = ts.isElementAccessExpression(callee) ? unwrap(callee.argumentExpression) : undefined;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

// messcript-disable-next-line CyclomaticComplexity
function writeTargets(node: ts.Node): ts.Expression[] {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    return assignmentTargets(node.left);
  }
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
    return [node.operand];
  }
  if (ts.isDeleteExpression(node)) {
    return [node.expression];
  }
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
    return assignmentTargets(node.initializer);
  }
  return [];
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function contentWriteTargets(node: ts.Node): ts.Expression[] {
  if (!ts.isCallExpression(node)) {
    return [];
  }
  const callee = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return [];
  }
  const receiver = unwrap(callee.expression);
  const name = methodName(callee);
  if (ts.isIdentifier(receiver) && receiver.text === "Object" && name === "assign") {
    return node.arguments.slice(0, 1);
  }
  return name && mutatingMethods.has(name) ? [receiver] : [];
}

// A compound write such as "x += 1" or "x++" also reads the old value.
function isCompoundWrite(node: ts.Node): boolean {
  return ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken);
}

function collectWrites(analysis: Analysis, node: ts.Node): void {
  for (const target of writeTargets(node)) {
    recordWrite(analysis, target, false, isCompoundWrite(node));
  }
  for (const target of contentWriteTargets(node)) {
    recordWrite(analysis, target, true, false);
  }
  ts.forEachChild(node, (child) => collectWrites(analysis, child));
}

function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) {
    return true;
  }
  const named = "name" in parent && parent.name === node;
  const propertyName = "propertyName" in parent && parent.propertyName === node;
  const label = "label" in parent && parent.label === node;
  return !named && !propertyName && !label;
}

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function memberAccess(node: ts.Identifier): MemberAccess | undefined {
  let receiver: ts.Expression = node;
  while (true) {
    const parent = receiver.parent;
    const wrapsReceiver = (
      ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)
    ) && parent.expression === receiver;
    if (wrapsReceiver) {
      receiver = parent;
      continue;
    }
    return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === receiver
      ? parent
      : undefined;
  }
}

function memberName(access: MemberAccess): string | undefined {
  if (ts.isPropertyAccessExpression(access)) {
    return access.name.text;
  }
  const argument = access.argumentExpression ? unwrap(access.argumentExpression) : undefined;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

// messcript-disable-next-line CyclomaticComplexity
function ambientCallDescription(node: ts.Identifier): string | undefined {
  const parent = node.parent;
  if (node.text === "Date" && (ts.isNewExpression(parent) || ts.isCallExpression(parent)) && parent.expression === node) {
    return (parent.arguments?.length ?? 0) === 0 ? `calls ${ts.isNewExpression(parent) ? "new " : ""}Date()` : undefined;
  }
  const access = memberAccess(node);
  if (!access || !ts.isCallExpression(access.parent) || access.parent.expression !== access) {
    return undefined;
  }
  const member = memberName(access);
  if (!member) {
    return undefined;
  }
  const name = `${node.text}.${member}`;
  return nondeterministicCalls.has(name) ? `calls ${name}()` : undefined;
}

function sinkName(node: ts.Identifier): string {
  const access = globalObjects.has(node.text) ? memberAccess(node) : undefined;
  return access ? memberName(access) ?? node.text : node.text;
}

function isDynamicGlobalKey(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!ts.isElementAccessExpression(parent) || !parent.argumentExpression || unwrap(parent.argumentExpression) !== node) {
    return false;
  }
  const receiver = unwrap(parent.expression);
  return ts.isIdentifier(receiver) && globalObjects.has(receiver.text);
}

function ambientFlow(node: ts.Identifier, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const sink = sinkName(node);
  if (outputSinks.has(sink) && !isDynamicGlobalKey(node)) {
    return ["output", `uses ${sink}`];
  }
  if (hostObjects.has(node.text)) {
    return write ? ["output", `writes ${node.text}`] : ["input", `reads ${node.text}`];
  }
  const call = ambientCallDescription(node);
  return call ? ["input", call] : undefined;
}

function bindingFlow(binding: Binding, node: ts.Identifier, functionNode: FunctionLike, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const outer = !isInside(binding.scope, functionNode);
  const directWrite = write && !write.viaCall;
  if (outer && directWrite) {
    return ["output", `writes ${node.text}`];
  }
  if (outer) {
    return binding.mutated ? ["input", `reads ${node.text}`] : undefined;
  }
  return binding.parameterOf === functionNode && directWrite && !write.reassign
    ? ["output", `mutates argument ${node.text}`]
    : undefined;
}

function thisFlow(node: ts.Node, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const parent = node.parent;
  const member = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : undefined;
  const subject = member ? `this.${member.name.text}` : "this";
  if (write && !write.viaCall) {
    return ["output", `writes ${subject}`];
  }
  const methodCall = member && ts.isCallExpression(member.parent) && member.parent.expression === member;
  return methodCall ? undefined : ["input", `reads ${subject}`];
}

function flowFor(analysis: Analysis, node: ts.Node, functionNode: FunctionLike, includeThis: boolean): [ImplicitFlowKind, string] | undefined {
  const write = analysis.writes.get(node);
  if (ts.isIdentifier(node) && isValueReference(node)) {
    const binding = resolve(analysis, node);
    return binding ? bindingFlow(binding, node, functionNode, write) : ambientFlow(node, write);
  }
  const thisReference = includeThis && node.kind === ts.SyntaxKind.ThisKeyword && !ts.isConstructorDeclaration(functionNode);
  return thisReference ? thisFlow(node, write) : undefined;
}

function flowsFor(analysis: Analysis, node: ts.Node, functionNode: FunctionLike, includeThis: boolean): Array<[ImplicitFlowKind, string]> {
  const flow = flowFor(analysis, node, functionNode, includeThis);
  if (!flow) {
    return [];
  }
  const compoundWrite = analysis.writes.get(node)?.compound && flow[1].startsWith("writes ");
  return compoundWrite ? [flow, ["input", flow[1].replace("writes ", "reads ")]] : [flow];
}

/**
 * Find the implicit inputs and implicit outputs of each function in a source file.
 * Arguments are explicit inputs. The return value is the explicit output.
 * Each function gets one flow for each kind and description.
 */
export function collectImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const analysis: Analysis = { scopes: new Map(), writes: new Map() };
  collectDeclarations(analysis, sourceFile);
  collectWrites(analysis, sourceFile);
  const flows: ImplicitFlow[] = [];
  const seen = new Map<FunctionLike, Set<string>>();
  function report(node: ts.Node, functionNode: FunctionLike): void {
    const reported = seen.get(functionNode) ?? new Set<string>();
    seen.set(functionNode, reported);
    for (const [kind, description] of flowsFor(analysis, node, functionNode, includeThis)) {
      if (!reported.has(`${kind}:${description}`)) {
        reported.add(`${kind}:${description}`);
        flows.push({ kind, node, functionNode, description });
      }
    }
  }
  function visit(node: ts.Node, functionNode: FunctionLike | undefined): void {
    if (ts.isTypeNode(node)) {
      return;
    }
    if (functionNode) {
      report(node, functionNode);
    }
    const childFunction = isFunctionLike(node) ? node : functionNode;
    ts.forEachChild(node, (child) => visit(child, childFunction));
  }
  visit(sourceFile, undefined);
  return flows;
}
