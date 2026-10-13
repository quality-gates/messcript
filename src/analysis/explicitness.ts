// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { isFunctionLike, isFunctionLikeWithBody } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import { methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { globalObjectMember, globalReference } from "../ast/global-reference";
import { analyzeScopes } from "../ast/scopes";
import type { Binding, ScopeModel, Write } from "../ast/scopes";
import {
  expressionStorageFact,
  hasCallerOrigin,
  hasExternalOrigin,
  hasReceiverOrigin,
  hasUnknownOrigin,
  joinStorageFacts,
  joinStorageOrigins,
  originsForPath,
  parameterOriginIndexes,
  storageFactAt,
  type CallStorageResolver,
  type StorageFact,
  type StorageOrigin,
  type StoragePath,
} from "./ownership";

export type ImplicitFlowKind = "input" | "output" | "unknown";

export type ImplicitFlow = {
  kind: ImplicitFlowKind;
  node: ts.Node;
  functionNode: FunctionLike;
  description: string;
  // A flow through a lexical binding records the binding, so an invoker that owns the binding can re-evaluate it.
  binding?: Binding;
  access?: BindingAccess;
  path?: StoragePath;
};

type BindingAccess = "read" | "reassign" | "contents";

type CallableTargets = {
  readonly targets: readonly FunctionLike[];
  readonly complete: boolean;
  readonly reason?: string;
};

type ParameterWrite = {
  readonly parameterIndex: number;
  readonly path: StoragePath;
  readonly node: ts.Node;
  readonly description: string;
};

type ParameterCall = {
  readonly parameterIndex: number;
  readonly node: ts.Node;
  readonly argumentFacts: readonly StorageFact[];
};

type CallableSummary = {
  readonly functionNode: FunctionLike;
  readonly flows: readonly ImplicitFlow[];
  readonly parameterWrites: readonly ParameterWrite[];
  readonly parameterCalls: readonly ParameterCall[];
  readonly returnedAliases: readonly StorageFact[];
  readonly returnedCallables: readonly FunctionLike[];
};

type CallEffects = {
  readonly flows: ImplicitFlow[];
  readonly writes: ParameterWrite[];
  readonly parameterCalls: ParameterCall[];
};

type AnalysisState = {
  readonly model: ScopeModel;
  readonly sourceFile: ts.SourceFile;
  readonly callables: readonly FunctionLike[];
  readonly callableByBinding: ReadonlyMap<Binding, FunctionLike>;
  readonly accessors: ReadonlyMap<string, readonly FunctionLike[]>;
  readonly includeThis: boolean;
};

const hostObjects = new Set([
  "document", "globalThis", "localStorage", "location", "navigator", "process", "self", "sessionStorage", "window",
]);

const outputSinks = new Set([
  "alert", "console", "fetch", "queueMicrotask", "requestAnimationFrame", "setInterval", "setTimeout",
]);

const nondeterministicCalls = new Set([
  "Date.now", "Math.random", "crypto.getRandomValues", "crypto.randomUUID", "performance.now",
]);

const pureGlobalCalls = new Set([
  "Array.isArray", "Boolean", "Number", "Object.entries", "Object.keys", "Object.values", "String",
  "Math.abs", "Math.ceil", "Math.floor", "Math.max", "Math.min", "Math.round", "Math.trunc",
]);

const pureMethods = new Set([
  "concat", "every", "filter", "find", "findIndex", "flat", "flatMap", "includes", "indexOf", "join", "map",
  "getTime", "reduce", "reduceRight", "slice", "some", "toFixed", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase",
  "toString", "toUpperCase", "trim", "trimEnd", "trimStart",
]);

const freshShallowMethods = new Set(["concat", "filter", "flat", "flatMap", "map", "slice"]);

const mutatingMethods = new Set([
  "add", "append", "appendChild", "clear", "copyWithin", "delete", "fill", "insertBefore", "pop", "prepend",
  "push", "remove", "removeAttribute", "removeChild", "removeItem", "replaceChildren", "reverse", "set",
  "setAttribute", "setItem", "shift", "sort", "splice", "unshift", "write", "writeln",
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

function parameterIndexOf(binding: Binding, functionNode: FunctionLike): number | undefined {
  const index = functionNode.parameters.findIndex((parameter) =>
    binding.declarations.some((declaration) => declaration.kind === "parameter" && declaration.node === parameter),
  );
  return index >= 0 ? index : undefined;
}

function parameterName(functionNode: FunctionLike, index: number): string {
  const parameter = functionNode.parameters[index];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : `#${index + 1}`;
}

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

function memberAccessOn(node: ts.Node): ts.Expression | undefined {
  const expression = outerExpression(node as ts.Expression);
  const parent = expression.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === expression
    ? parent
    : undefined;
}

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
  return undefined;
}

function rootIsThis(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current.kind === ts.SyntaxKind.ThisKeyword;
}

function isThisMethodCall(member: ts.Expression | undefined): boolean {
  if (!member) {
    return false;
  }
  const methodExpression = outerExpression(member);
  const parent = methodExpression.parent;
  return ts.isCallExpression(parent) && parent.expression === methodExpression;
}

function literalBooleanValue(expression: ts.Expression): boolean | undefined {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return undefined;
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

// Receiver state is reported as an input or output under include-this. Otherwise it is unknown,
// because excluding receiver state from the rules is not evidence that the state is pure.
function directFlowsFor(model: ScopeModel, node: ts.Node, functionNode: FunctionLike, includeThis: boolean): ImplicitFlow[] {
  const write = model.writeOf(node);
  if (ts.isIdentifier(node) && model.isReference(node)) {
    const binding = model.resolve(node);
    const flow = binding ? bindingFlow(binding, node, functionNode, write) : ambientFlow(node, write);
    return flow ? withCompoundRead(write, { kind: flow[0], node, functionNode, description: flow[1], ...bindingAccess(binding, node, write) }) : [];
  }
  if (node.kind !== ts.SyntaxKind.ThisKeyword || ts.isConstructorDeclaration(functionNode)) {
    return [];
  }
  const flow = thisFlow(node, write);
  return flow ? withCompoundRead(write, { kind: includeThis ? flow[0] : "unknown", node, functionNode, description: flow[1] }) : [];
}

function bindingAccess(binding: Binding | undefined, node: ts.Node, write: Write | undefined): Partial<ImplicitFlow> {
  if (!binding) {
    return {};
  }
  if (!write) {
    return { binding, access: "read" };
  }
  return write.reassign ? { binding, access: "reassign" } : { binding, access: "contents", path: writePath(node, write) };
}

function withCompoundRead(write: Write | undefined, flow: ImplicitFlow): ImplicitFlow[] {
  if (!write?.compound || !flow.description.startsWith("writes ")) {
    return [flow];
  }
  return [flow, { ...flow, kind: flow.kind === "unknown" ? "unknown" : "input", access: "read", description: flow.description.replace("writes ", "reads ") }];
}

function writePath(node: ts.Node, write: Write): StoragePath {
  if (write.contents) {
    return "outer";
  }
  let depth = 0;
  let current: ts.Node = outerExpression(node as ts.Expression);
  while (
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    depth += 1;
    current = outerExpression(current.parent);
  }
  return depth >= 2 ? "reachable" : "outer";
}

function returnStorageResolver(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
): CallStorageResolver {
  return (call, owner, site, seen) =>
    ts.isCallExpression(call) ? joinedReturnFactForCall(state, summaries, call, owner, seen) : undefined;
}

function storageFactForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  expression: ts.Expression,
  functionNode: FunctionLike,
  site: ts.Node,
): StorageFact {
  return expressionStorageFact(state.model, expression, functionNode, site, returnStorageResolver(state, summaries));
}

function storageFactForBinding(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  binding: Binding,
  functionNode: FunctionLike,
  site: ts.Node,
): StorageFact {
  return storageFactAt(state.model, binding, functionNode, site, new Set(), returnStorageResolver(state, summaries));
}

function mutationEffectsFor(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  node: ts.Node,
  functionNode: FunctionLike,
): { flows: ImplicitFlow[]; writes: ParameterWrite[] } {
  if (!ts.isIdentifier(node) || !state.model.isReference(node)) {
    return { flows: [], writes: [] };
  }
  const write = state.model.writeOf(node);
  const binding = state.model.resolve(node);
  if (!write || write.reassign || write.viaCall || !binding || !isInside(binding.scope.node, functionNode)) {
    return { flows: [], writes: [] };
  }
  const path = writePath(node, write);
  const fact = storageFactForBinding(state, summaries, binding, functionNode, node);
  return mutationEffectsFromFact(state, fact, path, node, functionNode, isParameterOf(binding, functionNode)
    ? `mutates argument ${node.text}`
    : `mutates caller-owned value ${node.text}`);
}

function mutationEffectsFromFact(
  state: AnalysisState,
  fact: StorageFact,
  path: StoragePath,
  node: ts.Node,
  functionNode: FunctionLike,
  description: string,
  receiverReported = false,
): CallEffects {
  const origins = originsForPath(fact, path);
  const writes = parameterOriginIndexes(origins).map((parameterIndex) => ({
    parameterIndex,
    path,
    node,
    description,
  }));
  return { flows: originFlows(state, origins, node, functionNode, description, receiverReported), writes, parameterCalls: [] };
}

// External storage makes a write an output. Receiver storage follows the include-this policy.
// Unknown storage without a known caller origin makes the write unknown.
function originFlows(
  state: AnalysisState,
  origins: readonly StorageOrigin[],
  node: ts.Node,
  functionNode: FunctionLike,
  description: string,
  receiverReported = false,
): ImplicitFlow[] {
  const flows: ImplicitFlow[] = [];
  if (hasExternalOrigin(origins)) {
    flows.push({ kind: "output", node, functionNode, description });
  }
  if (hasReceiverOrigin(origins) && !receiverReported) {
    flows.push({ kind: state.includeThis ? "output" : "unknown", node, functionNode, description: "mutates receiver state" });
  }
  if (hasUnknownOrigin(origins) && !hasCallerOrigin(origins)) {
    flows.push({ kind: "unknown", node, functionNode, description: "mutates value with unknown ownership" });
  }
  return flows;
}

function bindingCallable(binding: Binding): FunctionLike | undefined {
  for (const declaration of binding.declarations) {
    if (isFunctionLikeWithBody(declaration.node)) {
      return declaration.node;
    }
    if (ts.isVariableDeclaration(declaration.node) && declaration.node.initializer) {
      const initializer = unwrapExpression(declaration.node.initializer);
      if (isFunctionLikeWithBody(initializer)) {
        return initializer;
      }
    }
  }
  return undefined;
}

function collectCallables(sourceFile: ts.SourceFile, model: ScopeModel, includeThis: boolean): AnalysisState {
  const callables: FunctionLike[] = [];
  function visit(node: ts.Node): void {
    if (isFunctionLikeWithBody(node)) {
      callables.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const callableByBinding = new Map<Binding, FunctionLike>();
  for (const binding of model.bindings) {
    const callable = bindingCallable(binding);
    if (callable) {
      callableByBinding.set(binding, callable);
    }
  }
  return { model, sourceFile, callables, callableByBinding, accessors: new Map(), includeThis };
}

function callableTargets(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  expression: ts.Expression,
): readonly FunctionLike[] | undefined {
  const callee = unwrapExpression(expression);
  if (isFunctionLikeWithBody(callee)) {
    return [callee];
  }
  if (ts.isIdentifier(callee)) {
    return callableTargetsForIdentifier(state, summaries, callee);
  }
  if (ts.isCallExpression(callee)) {
    return returnedTargetsForCall(state, summaries, callee);
  }
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return methodTargets(state, callee);
  }
  return undefined;
}

function callableTargetsForIdentifier(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  callee: ts.Identifier,
): readonly FunctionLike[] | undefined {
  const binding = state.model.resolve(callee);
  if (!binding) {
    return undefined;
  }
  const declared = state.callableByBinding.get(binding);
  if (declared) {
    return [declared];
  }
  for (const declaration of binding.declarations) {
    const node = declaration.node;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(unwrapExpression(node.initializer))) {
      return returnedTargetsForCall(state, summaries, unwrapExpression(node.initializer) as ts.CallExpression);
    }
  }
  return undefined;
}

function methodTargets(state: AnalysisState, callee: ts.PropertyAccessExpression | ts.ElementAccessExpression): readonly FunctionLike[] | undefined {
  const name = methodName(callee);
  const receiver = unwrapExpression(callee.expression);
  if (!name || receiver.kind !== ts.SyntaxKind.ThisKeyword) {
    return undefined;
  }
  const owner = enclosingClass(callee);
  if (!owner) {
    return undefined;
  }
  return owner.members.filter((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && methodNameFromDeclaration(member) === name && member.body !== undefined,
  );
}

function methodNameFromDeclaration(member: ts.MethodDeclaration): string | undefined {
  const name = member.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
  }
  return undefined;
}

function returnedTargetsForCall(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
): readonly FunctionLike[] | undefined {
  const targets = callableTargets(state, summaries, call.expression);
  if (!targets) {
    return undefined;
  }
  return uniqueCallables(targets.flatMap((target) => summaries.get(target)?.returnedCallables ?? []));
}

function uniqueCallables(nodes: readonly FunctionLike[]): readonly FunctionLike[] {
  return [...new Set(nodes)];
}

function joinedReturnFactForCall(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
  seen: ReadonlySet<Binding>,
): StorageFact | undefined {
  const facts = returnFactsForCall(state, summaries, call, functionNode, seen);
  return facts === undefined || facts.length === 0 ? undefined : joinStorageFacts(facts);
}

function returnFactsForCall(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
  seen: ReadonlySet<Binding>,
): readonly StorageFact[] | undefined {
  const targets = callableTargets(state, summaries, call.expression);
  if (!targets) {
    const known = recognizedCallReturnFact(state, summaries, call, functionNode);
    return known ? [known] : undefined;
  }
  return uniqueFacts(targets.flatMap((target) => {
    const summary = summaries.get(target);
    return summary ? summary.returnedAliases.map((fact) => instantiateReturnFact(state, summaries, fact, call, functionNode, seen)) : [];
  }));
}

function recognizedCallReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
): StorageFact | undefined {
  const callee = unwrapExpression(call.expression);
  if (isRecognizedPureCall(call)) {
    return recognizedPureCallReturnFact(state, summaries, call, functionNode);
  }
  if (!isMutatingMethodCall(call, state.model)) {
    return undefined;
  }
  return recognizedMutationReturnFact(state, summaries, call, functionNode, callee);
}

function recognizedPureCallReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
): StorageFact {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return { outer: ["private"], reachable: ["private"] };
  }
  const name = methodName(callee);
  if (!name || !freshShallowMethods.has(name)) {
    return { outer: ["private"], reachable: ["private"] };
  }
  const receiver = storageFactForExpression(state, summaries, callee.expression, functionNode, call);
  return { outer: ["private"], reachable: receiver.reachable };
}

function recognizedMutationReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
  callee: ts.Expression,
): StorageFact | undefined {
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return undefined;
  }
  const name = methodName(callee);
  const receiver = unwrapExpression(callee.expression);
  if (ts.isIdentifier(receiver) && receiver.text === "Object" && name === "assign") {
    return call.arguments[0] ? storageFactForExpression(state, summaries, call.arguments[0], functionNode, call) : undefined;
  }
  return storageFactForExpression(state, summaries, callee.expression, functionNode, call);
}

function instantiateReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  fact: StorageFact,
  call: ts.CallExpression,
  functionNode: FunctionLike,
  seen: ReadonlySet<Binding>,
): StorageFact {
  const actualFact = (index: number) => {
    const actual = call.arguments[index];
    return actual
      ? expressionStorageFact(state.model, actual, functionNode, call, returnStorageResolver(state, summaries))
      : { outer: ["unknown"], reachable: ["unknown"] } satisfies StorageFact;
  };
  return instantiateStorageFact(fact, actualFact);
}

function instantiateStorageFact(
  fact: StorageFact,
  actualFact: (index: number) => StorageFact,
): StorageFact {
  return {
    outer: instantiateOrigins(fact.outer, "outer", actualFact),
    reachable: instantiateOrigins(fact.reachable, "reachable", actualFact),
  };
}

function instantiateOrigins(
  origins: readonly StorageOrigin[],
  path: StoragePath,
  actualFact: (index: number) => StorageFact,
): readonly StorageOrigin[] {
  return joinStorageOrigins(origins.flatMap((origin) => {
    if (!origin.startsWith("param:")) {
      return [origin];
    }
    const fact = actualFact(Number(origin.slice("param:".length)));
    return originsForPath(fact, path);
  }));
}

function returnedStorageFactsForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  expression: ts.Expression,
  functionNode: FunctionLike,
): readonly StorageFact[] {
  const value = unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    return returnFactsForCall(state, summaries, value, functionNode, new Set()) ?? [
      { outer: ["unknown"], reachable: ["unknown"] },
    ];
  }
  return [storageFactForExpression(state, summaries, expression, functionNode, expression)];
}

function uniqueFacts(facts: readonly StorageFact[]): readonly StorageFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = JSON.stringify({ outer: [...fact.outer].sort(), reachable: [...fact.reachable].sort() });
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isRecognizedPureCall(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return pureGlobalCalls.has(callee.text);
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }
  const name = methodName(callee);
  const receiver = unwrapExpression(callee.expression);
  if (!name) {
    return false;
  }
  const chain = globalReference(callee);
  if (chain && pureGlobalCalls.has(chain)) {
    return true;
  }
  if (ts.isIdentifier(receiver) && pureGlobalCalls.has(`${receiver.text}.${name}`)) {
    return true;
  }
  return pureMethods.has(name);
}

function isRecognizedEffectCall(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return outputSinks.has(callee.text) || callee.text === "Date";
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }
  return isRecognizedMemberEffectCall(callee);
}

function isRecognizedMemberEffectCall(callee: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const name = methodName(callee);
  const receiver = unwrapExpression(callee.expression);
  if (!name) {
    return false;
  }
  if (ts.isIdentifier(receiver) && nondeterministicCalls.has(`${receiver.text}.${name}`)) {
    return true;
  }
  const chain = globalReference(callee);
  const root = chain?.split(".")[0];
  if (root && outputSinks.has(root)) {
    return true;
  }
  const directRoot = ts.isIdentifier(receiver) ? globalObjectMember(callee) : undefined;
  return directRoot !== undefined && outputSinks.has(directRoot);
}

function isMutatingMethodCall(call: ts.CallExpression, model: ScopeModel): boolean {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }
  const name = methodName(callee);
  if (ts.isIdentifier(unwrapExpression(callee.expression)) && unwrapExpression(callee.expression).getText() === "Object" && name === "assign") {
    return true;
  }
  if (name && mutatingMethods.has(name)) {
    return true;
  }
  const receiver = unwrapExpression(callee.expression);
  return model.writeOf(receiver) !== undefined;
}

function returnedCallablesForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  expression: ts.Expression,
): readonly FunctionLike[] {
  const value = unwrapExpression(expression);
  if (isFunctionLikeWithBody(value)) {
    return [value];
  }
  if (ts.isIdentifier(value)) {
    const binding = state.model.resolve(value);
    return binding ? uniqueCallables([state.callableByBinding.get(binding)].filter((node): node is FunctionLike => node !== undefined)) : [];
  }
  if (ts.isConditionalExpression(value)) {
    return uniqueCallables([
      ...returnedCallablesForExpression(state, summaries, value.whenTrue),
      ...returnedCallablesForExpression(state, summaries, value.whenFalse),
    ]);
  }
  if (ts.isCallExpression(value)) {
    return returnedTargetsForCall(state, summaries, value) ?? [];
  }
  return [];
}

function parameterCallableIndex(state: AnalysisState, expression: ts.Expression, functionNode: FunctionLike): number | undefined {
  const callee = unwrapExpression(expression);
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const binding = state.model.resolve(callee);
  return binding ? parameterIndexOf(binding, functionNode) : undefined;
}

function emptyCallEffects(): CallEffects {
  return { flows: [], writes: [], parameterCalls: [] };
}

function callEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
): CallEffects {
  const targets = callableTargets(state, summaries, call.expression);
  if (!targets) {
    const parameterIndex = parameterCallableIndex(state, call.expression, functionNode);
    if (parameterIndex !== undefined) {
      return {
        flows: [],
        writes: [],
        parameterCalls: [{
          parameterIndex,
          node: call.expression,
          argumentFacts: call.arguments.map((argument) =>
            storageFactForExpression(state, summaries, argument, functionNode, call),
          ),
        }],
      };
    }
    if (isMutatingMethodCall(call, state.model)) {
      return mutatingMethodEffects(state, summaries, call, functionNode);
    }
    if (isRecognizedPureCall(call) || isRecognizedEffectCall(call)) {
      return emptyCallEffects();
    }
    return { flows: [{ kind: "unknown", node: call.expression, functionNode, description: "calls unresolved callable" }], writes: [], parameterCalls: [] };
  }
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const parameterCalls: ParameterCall[] = [];
  for (const target of targets) {
    const summary = summaries.get(target);
    if (!summary) {
      continue;
    }
    const effects = instantiateCallableSummary(state, summaries, summary, call.arguments, call.expression, functionNode);
    flows.push(...effects.flows);
    writes.push(...effects.writes);
    parameterCalls.push(...effects.parameterCalls);
  }
  return { flows, writes, parameterCalls };
}

function instantiateCallableSummary(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  summary: CallableSummary,
  actuals: readonly ts.Expression[],
  node: ts.Node,
  functionNode: FunctionLike,
  seen = new Set<string>(),
): CallEffects {
  const key = `${summary.functionNode.pos}:${actuals.map((actual) => actual.getStart()).join(",")}`;
  if (seen.has(key)) {
    return emptyCallEffects();
  }
  const nextSeen = new Set(seen).add(key);
  const flows: ImplicitFlow[] = summary.flows.map((flow) => ({ ...flow, node, functionNode }));
  const writes: ParameterWrite[] = [];
  const parameterCalls: ParameterCall[] = [];
  const actualFact = (index: number) => {
    const actual = actuals[index];
    return actual
      ? storageFactForExpression(state, summaries, actual, functionNode, node)
      : { outer: ["unknown"], reachable: ["unknown"] } satisfies StorageFact;
  };
  const writeEffects = instantiateParameterWrites(state, summary.parameterWrites, actuals, actualFact, node, functionNode);
  flows.push(...writeEffects.flows);
  writes.push(...writeEffects.writes);
  const callbackEffects = instantiateParameterCalls(
    state,
    summaries,
    summary.parameterCalls,
    actuals,
    actualFact,
    node,
    functionNode,
    nextSeen,
  );
  flows.push(...callbackEffects.flows);
  writes.push(...callbackEffects.writes);
  parameterCalls.push(...callbackEffects.parameterCalls);
  return { flows, writes, parameterCalls };
}

function instantiateParameterWrites(
  state: AnalysisState,
  parameterWrites: readonly ParameterWrite[],
  actuals: readonly ts.Expression[],
  actualFact: (index: number) => StorageFact,
  node: ts.Node,
  functionNode: FunctionLike,
): Pick<CallEffects, "flows" | "writes"> {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  for (const write of parameterWrites) {
    const actual = actuals[write.parameterIndex];
    if (!actual) {
      flows.push({ kind: "unknown", node, functionNode, description: "calls writable parameter without an argument" });
      continue;
    }
    const fact = actualFact(write.parameterIndex);
    const origins = originsForPath(fact, write.path);
    writes.push(...instantiatedWrites(origins, write.path, node, functionNode));
    if (hasExternalOrigin(origins)) {
      flows.push({ kind: "output", node, functionNode, description: `mutates caller-owned value ${actual.getText(state.sourceFile)}` });
    }
    if (hasUnknownOrigin(origins) && !hasCallerOrigin(origins)) {
      flows.push({ kind: "unknown", node, functionNode, description: "mutates value with unknown ownership" });
    }
  }
  return { flows, writes };
}

function instantiatedWrites(
  origins: readonly StorageOrigin[],
  path: StoragePath,
  node: ts.Node,
  functionNode: FunctionLike,
): ParameterWrite[] {
  return parameterOriginIndexes(origins).map((parameterIndex) => ({
    parameterIndex,
    path,
    node,
    description: `mutates argument ${parameterName(functionNode, parameterIndex)}`,
  }));
}

function instantiateParameterCalls(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  parameterCalls: readonly ParameterCall[],
  actuals: readonly ts.Expression[],
  actualFact: (index: number) => StorageFact,
  node: ts.Node,
  functionNode: FunctionLike,
  seen: Set<string>,
): CallEffects {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const forwardedCalls: ParameterCall[] = [];
  for (const parameterCall of parameterCalls) {
    const callback = actuals[parameterCall.parameterIndex];
    const argumentFacts = parameterCall.argumentFacts.map((fact) => instantiateStorageFact(fact, actualFact));
    if (!callback) {
      flows.push({ kind: "unknown", node, functionNode, description: "calls unresolved callable" });
      continue;
    }
    const callbackTargets = callableTargets(state, summaries, callback);
    if (!callbackTargets) {
      const callbackParameterIndex = parameterCallableIndex(state, callback, functionNode);
      if (callbackParameterIndex === undefined) {
        flows.push({ kind: "unknown", node, functionNode, description: "calls unresolved callable" });
      } else {
        forwardedCalls.push({ parameterIndex: callbackParameterIndex, node, argumentFacts });
      }
      continue;
    }
    const effects = instantiateCallbackTargets(state, summaries, callbackTargets, argumentFacts, node, functionNode, seen);
    flows.push(...effects.flows);
    writes.push(...effects.writes);
    forwardedCalls.push(...effects.parameterCalls);
  }
  return { flows, writes, parameterCalls: forwardedCalls };
}

function instantiateCallbackTargets(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  targets: readonly FunctionLike[],
  argumentFacts: readonly StorageFact[],
  node: ts.Node,
  functionNode: FunctionLike,
  seen: Set<string>,
): CallEffects {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const parameterCalls: ParameterCall[] = [];
  for (const target of targets) {
    const callbackSummary = summaries.get(target);
    if (!callbackSummary) {
      continue;
    }
    const effects = instantiateCallableSummaryFromFacts(
      state,
      summaries,
      callbackSummary,
      argumentFacts,
      node,
      functionNode,
      seen,
    );
    flows.push(...effects.flows);
    writes.push(...effects.writes);
    parameterCalls.push(...effects.parameterCalls);
  }
  return { flows, writes, parameterCalls };
}

function instantiateCallableSummaryFromFacts(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  summary: CallableSummary,
  actualFacts: readonly StorageFact[],
  node: ts.Node,
  functionNode: FunctionLike,
  seen: Set<string>,
): CallEffects {
  const key = `${summary.functionNode.pos}:${JSON.stringify(actualFacts)}`;
  if (seen.has(key)) {
    return emptyCallEffects();
  }
  const nextSeen = new Set(seen).add(key);
  const flows: ImplicitFlow[] = summary.flows.map((flow) => ({ ...flow, node, functionNode }));
  const writes: ParameterWrite[] = [];
  const parameterCalls: ParameterCall[] = [];
  const actualFact = (index: number) => actualFacts[index] ?? { outer: ["unknown"], reachable: ["unknown"] } satisfies StorageFact;
  for (const write of summary.parameterWrites) {
    const fact = actualFact(write.parameterIndex);
    const origins = originsForPath(fact, write.path);
    for (const parameterIndex of parameterOriginIndexes(origins)) {
      writes.push({
        parameterIndex,
        path: write.path,
        node,
        description: `mutates argument ${parameterName(functionNode, parameterIndex)}`,
      });
    }
    if (hasExternalOrigin(origins)) {
      flows.push({ kind: "output", node, functionNode, description: "mutates caller-owned callback argument" });
    }
    if (hasUnknownOrigin(origins) && !hasCallerOrigin(origins)) {
      flows.push({ kind: "unknown", node, functionNode, description: "mutates value with unknown ownership" });
    }
  }
  for (const parameterCall of summary.parameterCalls) {
    const argumentFacts = parameterCall.argumentFacts.map((fact) => instantiateStorageFact(fact, actualFact));
    flows.push({ kind: "unknown", node, functionNode, description: "calls unresolved callable" });
    if (nextSeen.size < state.callables.length + 1) {
      parameterCalls.push({ parameterIndex: parameterCall.parameterIndex, node, argumentFacts });
    }
  }
  return { flows, writes, parameterCalls };
}

function mutatingMethodEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
): CallEffects {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return emptyCallEffects();
  }
  const name = methodName(callee);
  const receiver = unwrapExpression(callee.expression);
  if (ts.isIdentifier(receiver) && receiver.text === "Object" && name === "assign") {
    return objectAssignEffects(state, summaries, call, functionNode);
  }
  if (ts.isIdentifier(receiver)) {
    return emptyCallEffects();
  }
  return receiverMutationEffects(state, summaries, call, functionNode, callee, name);
}

function objectAssignEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
): CallEffects {
  const assigned = call.arguments[0];
  if (!assigned || ts.isIdentifier(unwrapExpression(assigned))) {
    return emptyCallEffects();
  }
  return mutationEffectsFromFact(
    state,
    storageFactForExpression(state, summaries, assigned, functionNode, call),
    "outer",
    call.expression,
    functionNode,
    "mutates assigned object",
  );
}

function receiverMutationEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  call: ts.CallExpression,
  functionNode: FunctionLike,
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  name: string | undefined,
): CallEffects {
  const fact = storageFactForExpression(state, summaries, callee.expression, functionNode, call);
  const parameterIndexes = parameterOriginIndexes(originsForPath(fact, "outer"));
  return mutationEffectsFromFact(
    state,
    fact,
    "outer",
    call.expression,
    functionNode,
    parameterIndexes.length === 1
      ? `mutates argument ${parameterName(functionNode, parameterIndexes[0])}`
      : `mutates receiver of ${name ?? "call"}`,
    rootIsThis(callee.expression),
  );
}

function summarizeCallable(
  state: AnalysisState,
  summaries: ReadonlyMap<FunctionLike, CallableSummary>,
  functionNode: FunctionLike,
  includeThis: boolean,
): CallableSummary {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const parameterCalls: ParameterCall[] = [];
  const returnedAliases: StorageFact[] = [];
  const returnedCallables: FunctionLike[] = [];
  function addFlow(flow: ImplicitFlow): void {
    flows.push(flow);
  }
  function visit(node: ts.Node): void {
    if (node !== functionNode && isFunctionLike(node)) {
      return;
    }
    if (ts.isTypeNode(node)) {
      return;
    }
    for (const flow of directFlowsFor(state.model, node, functionNode, includeThis)) {
      addFlow(flow);
    }
    const mutation = mutationEffectsFor(state, summaries, node, functionNode);
    flows.push(...mutation.flows);
    writes.push(...mutation.writes);
    if (ts.isCallExpression(node)) {
      const effects = callEffects(state, summaries, node, functionNode);
      flows.push(...effects.flows);
      writes.push(...effects.writes);
      parameterCalls.push(...effects.parameterCalls);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returnedAliases.push(...returnedStorageFactsForExpression(state, summaries, node.expression, functionNode));
      returnedCallables.push(...returnedCallablesForExpression(state, summaries, node.expression));
    }
    if (visitReachableChildren(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  function visitReachableChildren(node: ts.Node): boolean {
    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const condition = literalBooleanValue(node.expression);
      if (condition === true) {
        visit(node.thenStatement);
      } else if (condition === false) {
        if (node.elseStatement) {
          visit(node.elseStatement);
        }
      } else {
        visit(node.thenStatement);
        if (node.elseStatement) {
          visit(node.elseStatement);
        }
      }
      return true;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition);
      const condition = literalBooleanValue(node.condition);
      if (condition === true) {
        visit(node.whenTrue);
      } else if (condition === false) {
        visit(node.whenFalse);
      } else {
        visit(node.whenTrue);
        visit(node.whenFalse);
      }
      return true;
    }
    return false;
  }
  visit(functionNode);
  return {
    functionNode,
    flows: uniqueFlows(flows),
    parameterWrites: uniqueWrites(writes),
    parameterCalls: uniqueParameterCalls(parameterCalls),
    returnedAliases: uniqueFacts(returnedAliases),
    returnedCallables: uniqueCallables(returnedCallables),
  };
}

function uniqueFlows(flows: readonly ImplicitFlow[]): readonly ImplicitFlow[] {
  const seen = new Set<string>();
  return flows.filter((flow) => {
    const key = `${flow.functionNode.pos}:${flow.kind}:${flow.description}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueWrites(writes: readonly ParameterWrite[]): readonly ParameterWrite[] {
  const seen = new Set<string>();
  return writes.filter((write) => {
    const key = `${write.parameterIndex}:${write.path}:${write.description}:${write.node.getStart()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueParameterCalls(calls: readonly ParameterCall[]): readonly ParameterCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.parameterIndex}:${call.node.getStart()}:${JSON.stringify(call.argumentFacts)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function summaryKey(summary: CallableSummary): string {
  return JSON.stringify({
    flows: summary.flows.map((flow) => [flow.kind, flow.description, flow.node.getStart()]).sort(),
    writes: summary.parameterWrites.map((write) => [write.parameterIndex, write.path, write.description, write.node.getStart()]).sort(),
    calls: summary.parameterCalls.map((call) => [call.parameterIndex, call.node.getStart(), call.argumentFacts]).sort(),
    aliases: summary.returnedAliases.map((fact) => [fact.outer, fact.reachable]).sort(),
    returns: summary.returnedCallables.map((node) => node.pos).sort((left, right) => left - right),
  });
}

function analyzeImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const model = analyzeScopes(sourceFile);
  const state = collectCallables(sourceFile, model, includeThis);
  let summaries = new Map<FunctionLike, CallableSummary>(state.callables.map((functionNode) => [
    functionNode,
    { functionNode, flows: [], parameterWrites: [], parameterCalls: [], returnedAliases: [], returnedCallables: [] },
  ]));
  for (let index = 0; index < state.callables.length + 8; index += 1) {
    let changed = false;
    const next = new Map<FunctionLike, CallableSummary>();
    for (const functionNode of state.callables) {
      const summary = summarizeCallable(state, summaries, functionNode, includeThis);
      next.set(functionNode, summary);
      changed ||= summaryKey(summary) !== summaryKey(summaries.get(functionNode) ?? summary);
    }
    summaries = next;
    if (!changed) {
      break;
    }
  }
  const flows: ImplicitFlow[] = [];
  for (const summary of summaries.values()) {
    flows.push(...summary.flows);
    flows.push(...summary.parameterWrites.map((write) => ({
      kind: "output" as const,
      node: write.node,
      functionNode: summary.functionNode,
      description: write.description,
    })));
    flows.push(...summary.parameterCalls.map((call) => ({
      kind: "unknown" as const,
      node: call.node,
      functionNode: summary.functionNode,
      description: "calls unresolved callable",
    })));
  }
  return uniqueFlows(flows) as ImplicitFlow[];
}

const flowCacheSymbol = Symbol("explicitnessFlowCache");
type CachedSourceFile = ts.SourceFile & {
  [flowCacheSymbol]?: Map<boolean, readonly ImplicitFlow[]>;
};

export function collectImplicitFlows(
  sourceFile: ts.SourceFile,
  includeThis: boolean = false,
): readonly ImplicitFlow[] {
  const cachedSourceFile = sourceFile as CachedSourceFile;
  let cachedByThis = cachedSourceFile[flowCacheSymbol];
  if (!cachedByThis) {
    cachedByThis = new Map();
    cachedSourceFile[flowCacheSymbol] = cachedByThis;
  }
  let flows = cachedByThis.get(includeThis);
  if (!flows) {
    flows = analyzeImplicitFlows(sourceFile, includeThis);
    cachedByThis.set(includeThis, flows);
  }
  return flows;
}
