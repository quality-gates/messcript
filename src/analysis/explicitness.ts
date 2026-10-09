// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { isFunctionLike } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import { methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { globalObjectMember } from "../ast/global-reference";
import { analyzeScopes } from "../ast/scopes";
import type { Binding, ScopeModel, Write } from "../ast/scopes";

export type ImplicitFlowKind = "input" | "output";

export type ImplicitFlow = {
  kind: ImplicitFlowKind;
  node: ts.Node;
  functionNode: FunctionLike;
  description: string;
};

// Ambient objects that hold host state. A read is an input and a write is an output.
const hostObjects = new Set([
  "document", "globalThis", "localStorage", "location", "navigator", "process", "self", "sessionStorage", "window",
]);

// Ambient functions and objects that only send data out of the function.
const outputSinks = new Set([
  "alert", "console", "fetch", "queueMicrotask", "requestAnimationFrame", "setInterval", "setTimeout",
]);

// Ambient calls that give a different result on each call.
const nondeterministicCalls = new Set([
  "Date.now", "Math.random", "crypto.getRandomValues", "crypto.randomUUID", "performance.now",
]);

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function isParameterOf(binding: Binding, functionNode: FunctionLike): boolean {
  return binding.declarations.some((declaration) => declaration.kind === "parameter" && declaration.node.parent === functionNode);
}

// messcript-disable-next-line CyclomaticComplexity
function dateCallDescription(expression: ts.Expression): string | undefined {
  const parent = expression.parent;
  if ((!ts.isNewExpression(parent) && !ts.isCallExpression(parent)) || parent.expression !== expression) {
    return undefined;
  }
  if ((parent.arguments?.length ?? 0) !== 0) {
    return undefined;
  }
  return `calls ${ts.isNewExpression(parent) ? "new " : ""}Date()`;
}

function ambientMethodCallName(expression: ts.Expression): string | undefined {
  const access = outerExpression(expression).parent;
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) {
    return undefined;
  }
  const callee = outerExpression(access);
  const call = callee.parent;
  if (!ts.isCallExpression(call) || call.expression !== callee) {
    return undefined;
  }
  const method = methodName(access);
  const receiver = unwrapExpression(access.expression);
  if (!method || !ts.isIdentifier(receiver)) {
    return undefined;
  }
  return `${receiver.text}.${method}`;
}

function ambientCallDescription(node: ts.Identifier): string | undefined {
  const expression = outerExpression(node);
  if (node.text === "Date") {
    const dateCall = dateCallDescription(expression);
    if (dateCall) {
      return dateCall;
    }
  }
  const name = ambientMethodCallName(expression);
  return name && nondeterministicCalls.has(name) ? `calls ${name}()` : undefined;
}

// A sink is also reached through the global object, as in window.alert().
function sinkName(node: ts.Identifier): string {
  const access = memberAccessOn(node);
  return (access && globalObjectMember(access)) ?? node.text;
}

function ambientFlow(node: ts.Identifier, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const sink = sinkName(node);
  if (outputSinks.has(sink)) {
    return ["output", `uses ${sink}`];
  }
  if (hostObjects.has(node.text)) {
    return write ? ["output", `writes ${node.text}`] : ["input", `reads ${node.text}`];
  }
  const call = ambientCallDescription(node);
  return call ? ["input", call] : undefined;
}

function bindingFlow(binding: Binding, node: ts.Identifier, functionNode: FunctionLike, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const outer = !isInside(binding.scope.node, functionNode);
  const directWrite = write && !write.viaCall;
  if (outer && directWrite) {
    return ["output", `writes ${node.text}`];
  }
  if (outer) {
    return binding.mutated ? ["input", `reads ${node.text}`] : undefined;
  }
  return isParameterOf(binding, functionNode) && directWrite && !write.reassign
    ? ["output", `mutates argument ${node.text}`]
    : undefined;
}

// The member access that has the node as its receiver.
function memberAccessOn(node: ts.Node): ts.Expression | undefined {
  const expression = outerExpression(node as ts.Expression);
  const parent = expression.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === expression
    ? parent
    : undefined;
}

function isThisMethodCall(member: ts.Expression | undefined): boolean {
  if (!member) {
    return false;
  }
  const methodExpression = outerExpression(member);
  const parent = methodExpression.parent;
  return ts.isCallExpression(parent) && parent.expression === methodExpression;
}

function thisFlow(node: ts.Node, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const member = memberAccessOn(node);
  const memberName = member && methodName(member);
  const subject = memberName !== undefined ? `this.${memberName}` : "this";
  if (write && !write.viaCall) {
    return ["output", `writes ${subject}`];
  }
  return isThisMethodCall(member) ? undefined : ["input", `reads ${subject}`];
}

function flowFor(model: ScopeModel, node: ts.Node, functionNode: FunctionLike, includeThis: boolean): [ImplicitFlowKind, string] | undefined {
  const write = model.writeOf(node);
  if (ts.isIdentifier(node) && model.isReference(node)) {
    const binding = model.resolve(node);
    return binding ? bindingFlow(binding, node, functionNode, write) : ambientFlow(node, write);
  }
  const thisReference = includeThis && node.kind === ts.SyntaxKind.ThisKeyword && !ts.isConstructorDeclaration(functionNode);
  return thisReference ? thisFlow(node, write) : undefined;
}

function flowsFor(model: ScopeModel, node: ts.Node, functionNode: FunctionLike, includeThis: boolean): Array<[ImplicitFlowKind, string]> {
  const flow = flowFor(model, node, functionNode, includeThis);
  if (!flow) {
    return [];
  }
  const compoundWrite = model.writeOf(node)?.compound && flow[1].startsWith("writes ");
  return compoundWrite ? [flow, ["input", flow[1].replace("writes ", "reads ")]] : [flow];
}

/**
 * Find the implicit inputs and implicit outputs of each function in a source file.
 * Arguments are explicit inputs. The return value is the explicit output.
 * Each function gets one flow for each kind and description.
 */
// messcript-disable-next-line GlobalVariable
const flowCacheByFile = new WeakMap<ts.SourceFile, Map<boolean, readonly ImplicitFlow[]>>();

function analyzeImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const model = analyzeScopes(sourceFile);
  const flows: ImplicitFlow[] = [];
  const seen = new Map<FunctionLike, Set<string>>();
  function report(node: ts.Node, functionNode: FunctionLike): void {
    const reported = seen.get(functionNode) ?? new Set<string>();
    seen.set(functionNode, reported);
    for (const [kind, description] of flowsFor(model, node, functionNode, includeThis)) {
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

/**
 * Find the implicit inputs and implicit outputs of each function in a source file.
 * Arguments are explicit inputs. The return value is the explicit output.
 * Each function gets one flow for each kind and description.
 */
export function collectImplicitFlows(
  sourceFile: ts.SourceFile,
  includeThis: boolean = false,
): readonly ImplicitFlow[] {
  let cachedByThis = flowCacheByFile.get(sourceFile);
  if (!cachedByThis) {
    cachedByThis = new Map();
    flowCacheByFile.set(sourceFile, cachedByThis);
  }
  let flows = cachedByThis.get(includeThis);
  if (!flows) {
    flows = analyzeImplicitFlows(sourceFile, includeThis);
    cachedByThis.set(includeThis, flows);
  }
  return flows;
}
