// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { globalName } from "../ast/global-reference";
import { isFunctionLike, isFunctionLikeWithBody } from "../ast/functions";
import { methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { analyzeScopes } from "../ast/scopes";
import type { Binding, ScopeModel, Write } from "../ast/scopes";
import { bindingAssignments, inside } from "./assignments";
import { callableTargets as resolveTargets, classTargets, memberTargets, type Dispatch, type Targets } from "./dispatch";
import { ambientFlow, isPureConstructor, libraryCall, libraryCallback, type LibraryCall } from "./library";
import { protocolExpressions, supportsProtocol } from "./protocols";
import {
  baseClassExpression, collectOwners, enclosingClass, explicitConstructor, instanceInitializers, isConstruction,
  isGenerator, isInstanceField, ownerKey, ownerParameters, type EffectOwner,
} from "./owners";
import {
  expressionStorageFact,
  externalBindingOrigin,
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
  owner: EffectOwner;
  description: string;
  binding?: Binding;
  access?: BindingAccess;
  path?: StoragePath;
  receiver?: "read" | "write";
  defaultParameterIndex?: number;
};

type BindingAccess = "read" | "reassign" | "contents";

type ParameterWrite = {
  readonly parameterIndex: number;
  readonly path: StoragePath;
  readonly node: ts.Node;
  readonly description: string;
  readonly defaultParameterIndex?: number;
};

type ParameterCall = {
  readonly parameterIndex: number;
  readonly node: ts.Node;
  readonly argumentFacts: readonly StorageFact[];
  readonly defaultParameterIndex?: number;
};

type CallableSummary = {
  readonly owner: EffectOwner;
  readonly flows: readonly ImplicitFlow[];
  readonly parameterWrites: readonly ParameterWrite[];
  readonly parameterCalls: readonly ParameterCall[];
  readonly returnedAliases: readonly StorageFact[];
  readonly returnedCallables: readonly EffectOwner[];
  readonly opaqueReturn: boolean;
};

type CallEffects = {
  readonly flows: ImplicitFlow[];
  readonly writes: ParameterWrite[];
  readonly parameterCalls: ParameterCall[];
};

type AnalysisState = {
  readonly model: ScopeModel;
  readonly sourceFile: ts.SourceFile;
  readonly callables: readonly EffectOwner[];
  summaries: ReadonlyMap<EffectOwner, CallableSummary>;
  readonly includeThis: boolean;
  readonly sharedBindings: Set<Binding>;
  readonly bindingOrigins: ReadonlyMap<StorageOrigin, Binding>;
};

const privateFact: StorageFact = { outer: ["private"], reachable: ["private"] };
const unknownFact: StorageFact = { outer: ["unknown"], reachable: ["unknown"] };

function isParameterOf(binding: Binding, owner: EffectOwner): boolean {
  return parameterIndexOf(binding, owner) !== undefined;
}

function parameterIndexOf(binding: Binding, owner: EffectOwner): number | undefined {
  const index = ownerParameters(owner).findIndex((parameter) =>
    binding.declarations.some((declaration) => declaration.kind === "parameter" && declaration.node === parameter),
  );
  return index >= 0 ? index : undefined;
}

function parameterName(owner: EffectOwner, index: number): string {
  const parameter = ownerParameters(owner)[index];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : `#${index + 1}`;
}

function isRootExpression(node: ts.Node): node is ts.Identifier | ts.ThisExpression {
  return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword;
}

function memberAccessOn(node: ts.Node): ts.Expression | undefined {
  if (!isRootExpression(node)) {
    return undefined;
  }
  const expression = outerExpression(node);
  const parent = expression.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === expression
    ? parent
    : undefined;
}

function bindingFlow(binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined, shared: boolean): [ImplicitFlowKind, string] | undefined {
  const outer = ts.isSourceFile(owner) ? isModuleScope(binding) : !inside(binding.scope.node, owner);
  const directWrite = write && !write.viaCall;
  if (outer && directWrite) {
    return ["output", `writes ${node.text}`];
  }
  if (outer) {
    return binding.mutated || shared || isExportedStorage(binding) ? ["input", `reads ${node.text}`] : undefined;
  }
  return undefined;
}

function isModuleScope(binding: Binding): boolean {
  return binding.scope.kind === "file" || binding.scope.kind === "namespace";
}

function isExportedStorage(binding: Binding): boolean {
  if (!isExportedBinding(binding)) {
    return false;
  }
  return binding.declarations.some((declaration) => {
    if (!ts.isVariableDeclaration(declaration.node)) {
      return false;
    }
    const list = declaration.node.parent;
    const value = declaration.node.initializer;
    return !(list.flags & ts.NodeFlags.Const) || value === undefined || !isScalarLiteral(value);
  });
}

function isExportedBinding(binding: Binding): boolean {
  return hasNamedExport(binding) || binding.declarations.some((declaration) =>
    hasExportModifier(ts.isVariableDeclaration(declaration.node) ? declaration.node.parent.parent : declaration.node),
  );
}

function isScalarLiteral(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  return (ts.isLiteralExpression(value) && !ts.isRegularExpressionLiteral(value)) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword || ts.isPrefixUnaryExpression(value);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function hasNamedExport(binding: Binding): boolean {
  if (binding.scope.kind !== "file") {
    return false;
  }
  return binding.scope.node.getSourceFile().statements.some((statement) =>
    ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly &&
    statement.exportClause && ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === binding.name),
  );
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
function directFlowsFor(state: AnalysisState, node: ts.Node, owner: EffectOwner, includeThis: boolean): ImplicitFlow[] {
  const write = state.model.writeOf(node);
  if (ts.isIdentifier(node) && state.model.isReference(node)) {
    return identifierFlows(state, node, owner, write);
  }
  return directReceiverFlows(node, owner, includeThis, write);
}

function directReceiverFlows(node: ts.Node, owner: EffectOwner, includeThis: boolean, write: Write | undefined): ImplicitFlow[] {
  if (!isRootExpression(node) || node.kind !== ts.SyntaxKind.ThisKeyword || isConstruction(owner)) {
    return [];
  }
  const flow = thisFlow(node, write);
  return flow ? withCompoundRead(write, { kind: includeThis ? flow[0] : "unknown", node, owner, description: flow[1], receiver: flow[0] === "output" ? "write" : "read", path: write ? writePath(node, write) : "outer" }) : [];
}

function identifierFlows(state: AnalysisState, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ImplicitFlow[] {
  const binding = state.model.resolve(node);
  const flow = binding ? bindingFlow(binding, node, owner, write, state.sharedBindings.has(binding)) : ambientFlow(node, write !== undefined);
  return flow ? withCompoundRead(write, { kind: flow[0], node, owner, description: flow[1], ...bindingAccess(binding, node, write) }) : [];
}

function bindingAccess(binding: Binding | undefined, node: ts.Identifier, write: Write | undefined): Partial<ImplicitFlow> {
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

function writePath(node: ts.Expression, write: Write): StoragePath {
  return memberDepth(node) >= 2 ? "reachable" : "outer";
}

function memberDepth(node: ts.Expression): number {
  let depth = 0;
  let current: ts.Node = outerExpression(node);
  while (
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    depth += 1;
    current = outerExpression(current.parent);
  }
  return depth;
}

function returnStorageResolver(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
): CallStorageResolver {
  return (call, owner, site, seen) =>
    ts.isCallExpression(call) ? joinedReturnFactForCall(state, summaries, call, owner, seen) : undefined;
}

function storageFactForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
): StorageFact {
  return expressionStorageFact(state.model, expression, owner, site, returnStorageResolver(state, summaries));
}

function storageFactForBinding(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  binding: Binding,
  owner: EffectOwner,
  site: ts.Node,
): StorageFact {
  return storageFactAt(state.model, binding, owner, site, new Set(), returnStorageResolver(state, summaries));
}

function mutationEffectsFor(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Node,
  owner: EffectOwner,
): { flows: ImplicitFlow[]; writes: ParameterWrite[] } {
  if (!ts.isIdentifier(node)) {
    return { flows: [], writes: [] };
  }
  const write = state.model.writeOf(node);
  const binding = state.model.resolve(node);
  if (!write || write.reassign || write.viaCall || !binding || !inside(binding.scope.node, owner)) {
    return { flows: [], writes: [] };
  }
  if (isNestedMethodReceiver(node)) {
    return { flows: [], writes: [] };
  }
  const path = writePath(node, write);
  const fact = storageFactForBinding(state, summaries, binding, owner, node);
  return mutationEffectsFromFact(state, fact, path, node, owner, isParameterOf(binding, owner)
    ? `mutates argument ${node.text}`
    : `mutates caller-owned value ${node.text}`);
}

function isNestedMethodReceiver(node: ts.Identifier): boolean {
  let current: ts.Expression = outerExpression(node);
  while ((ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) && current.parent.expression === current) {
    current = current.parent;
  }
  if (!ts.isCallExpression(current.parent) || current.parent.expression !== current ||
      (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current))) {
    return false;
  }
  return !ts.isIdentifier(unwrapExpression(current.expression));
}

function mutationEffectsFromFact(
  state: AnalysisState,
  fact: StorageFact,
  path: StoragePath,
  node: ts.Node,
  owner: EffectOwner,
  description: string,
  receiverReported = false,
  parameterDescription = false,
): CallEffects {
  const origins = originsForPath(fact, path);
  const writes = parameterOriginIndexes(origins).map((parameterIndex) => ({
    parameterIndex,
    path,
    node,
    description: parameterDescription ? `mutates argument ${parameterName(owner, parameterIndex)}` : description,
  }));
  return { flows: originFlows(state, origins, node, owner, description, receiverReported), writes, parameterCalls: [] };
}

// External storage makes a write an output. Receiver storage follows the include-this policy.
// Unknown storage retains uncertainty even when a known origin is also present.
function originFlows(
  state: AnalysisState,
  origins: readonly StorageOrigin[],
  node: ts.Node,
  owner: EffectOwner,
  description: string,
  receiverReported = false,
): ImplicitFlow[] {
  const flows: ImplicitFlow[] = [];
  if (hasExternalOrigin(origins)) {
    shareOrigins(state, origins);
    flows.push({ kind: "output", node, owner, description });
  }
  if (hasReceiverOrigin(origins) && !receiverReported) {
    flows.push({ kind: state.includeThis ? "output" : "unknown", node, owner, description: "mutates receiver state", receiver: "write", path: "outer" });
  }
  if (hasUnknownOrigin(origins)) {
    flows.push({ kind: "unknown", node, owner, description: "mutates value with unknown ownership" });
  }
  return flows;
}

function collectCallables(sourceFile: ts.SourceFile, model: ScopeModel, includeThis: boolean): AnalysisState {
  return {
    model, sourceFile, callables: collectOwners(sourceFile), summaries: new Map(), includeThis,
    sharedBindings: new Set(), bindingOrigins: new Map(model.bindings.map((binding) => [externalBindingOrigin(binding), binding])),
  };
}

function shareOrigins(state: AnalysisState, origins: readonly StorageOrigin[]): void {
  for (const origin of origins) {
    const binding = state.bindingOrigins.get(origin);
    if (binding) {
      state.sharedBindings.add(binding);
    }
  }
}

function shareExposedReturns(state: AnalysisState, summary: CallableSummary): void {
  const owner = summary.owner;
  if (!isExposedOwner(state, owner)) {
    return;
  }
  const origins = summary.returnedAliases.flatMap((fact) => [...fact.outer, ...fact.reachable]);
  shareOrigins(state, origins.filter((origin) => {
    const binding = state.bindingOrigins.get(origin);
    return binding?.declarations.some((declaration) =>
      ts.isVariableDeclaration(declaration.node) &&
      (!declaration.node.initializer || !isDefinedLiteral(declaration.node.initializer) ||
        ts.isArrayLiteralExpression(declaration.node.initializer) || ts.isObjectLiteralExpression(declaration.node.initializer)),
    );
  }));
}

function isExposedOwner(state: AnalysisState, owner: EffectOwner): boolean {
  if (hasExportModifier(owner)) {
    return true;
  }
  return state.model.bindings.some((binding) => isExportedBinding(binding) && binding.declarations.some((declaration) =>
    declaration.node === owner || ts.isVariableDeclaration(declaration.node) && declaration.node.initializer &&
      unwrapExpression(declaration.node.initializer) === owner,
  ));
}

function dispatchFor(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>): Dispatch {
  return { model: state.model, owners: state.callables, returns: (call, seen) => {
    const targets = resolveTargets(dispatchFor(state, summaries), call.expression, seen);
    const returned = targets.targets.flatMap((target) => summaries.get(target)?.returnedCallables ?? []);
    const complete = targets.complete && targets.targets.every((target) => !summaries.get(target)?.opaqueReturn);
    return { targets: uniqueCallables(returned), complete };
  } };
}

function callableTargets(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
): readonly EffectOwner[] | undefined {
  const resolved = resolveTargets(dispatchFor(state, summaries), expression);
  return resolved.complete ? resolved.targets : undefined;
}

function uniqueCallables(nodes: readonly EffectOwner[]): readonly EffectOwner[] {
  return [...new Set(nodes)];
}

function joinedReturnFactForCall(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  seen: ReadonlySet<Binding>,
): StorageFact | undefined {
  const facts = returnFactsForCall(state, summaries, call, owner, seen);
  return facts === undefined || facts.length === 0 ? undefined : joinStorageFacts(facts);
}

function returnFactsForCall(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  seen: ReadonlySet<Binding>,
): readonly StorageFact[] | undefined {
  const targets = callableTargets(state, summaries, call.expression);
  if (!targets) {
    const known = recognizedCallReturnFact(state, summaries, call, owner);
    return known ? [known] : undefined;
  }
  return uniqueFacts(targets.flatMap((target) => {
    const summary = summaries.get(target);
    return summary ? summary.returnedAliases.map((fact) => instantiateReturnFact(state, summaries, fact, call, owner, seen)) : [];
  }));
}

function recognizedCallReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): StorageFact | undefined {
  const known = libraryCall(call, state.model);
  if (!known || known.kind === "effect") {
    return undefined;
  }
  const target = libraryTarget(call, known);
  const receiver = target ? storageFactForExpression(state, summaries, target, owner, call) : privateFact;
  return libraryReturnFact(state, summaries, call, owner, known, receiver);
}

function libraryReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
  receiver: StorageFact,
): StorageFact {
  switch (known.result) {
    case "fresh": return privateFact;
    case "shallow": return { outer: ["private"], reachable: receiver.reachable };
    case "element": return { outer: receiver.reachable, reachable: receiver.reachable };
    case "receiver": return receiver;
    case "holding": return holdingReturnFact(state, summaries, call, owner, receiver);
    case "mapped": return mappedReturnFact(state, summaries, call, owner, known);
  }
}

function libraryTarget(call: ts.CallExpression, known: Exclude<LibraryCall, { kind: "effect" }>): ts.Expression | undefined {
  if (known.target === "argument") {
    return call.arguments[0];
  }
  const callee = unwrapExpression(call.expression);
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
}

function holdingReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  receiver: StorageFact,
): StorageFact {
  const facts = call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call));
  const held = [receiver, ...facts].flatMap((fact) => [...fact.outer, ...fact.reachable]);
  return { outer: ["private"], reachable: joinStorageOrigins(held) };
}

function mappedReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
): StorageFact {
  const callback = call.arguments[known.callbacks[0]];
  const targets = callback && callableTargets(state, summaries, callback);
  if (!targets) {
    return unknownFact;
  }
  const actualFacts = libraryCallbackFacts(state, summaries, call, owner, known);
  const returns = targets.flatMap((target) => (summaries.get(target)?.returnedAliases ?? []).map((fact) =>
    instantiateStorageFact(fact, (index) => actualFacts[index] ?? unknownFact),
  ));
  const callee = unwrapExpression(call.expression);
  const name = methodName(callee);
  if (name === "reduce" || name === "reduceRight") {
    return joinStorageFacts([call.arguments[1] ? storageFactForExpression(state, summaries, call.arguments[1], owner, call) : unknownFact, ...returns]);
  }
  return { outer: ["private"], reachable: joinStorageOrigins(returns.flatMap((fact) => [...fact.outer, ...fact.reachable])) };
}

function instantiateReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  fact: StorageFact,
  call: ts.CallExpression,
  owner: EffectOwner,
  seen: ReadonlySet<Binding>,
): StorageFact {
  const actualFact = (index: number) => {
    const actual = call.arguments[index];
    return actual
      ? expressionStorageFact(state.model, actual, owner, call, returnStorageResolver(state, summaries))
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
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
  owner: EffectOwner,
): readonly StorageFact[] {
  const value = unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    return returnFactsForCall(state, summaries, value, owner, new Set()) ?? [
      { outer: ["unknown"], reachable: ["unknown"] },
    ];
  }
  return [storageFactForExpression(state, summaries, expression, owner, expression)];
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

function returnedCallablesForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
): Targets {
  return resolveTargets(dispatchFor(state, summaries), expression);
}

function parameterCallableIndex(state: AnalysisState, expression: ts.Expression, owner: EffectOwner): number | undefined {
  const callee = unwrapExpression(expression);
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const binding = state.model.resolve(callee);
  return binding ? parameterIndexOf(binding, owner) : undefined;
}

function emptyCallEffects(): CallEffects {
  return { flows: [], writes: [], parameterCalls: [] };
}

function callEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): CallEffects {
  if (unwrapExpression(call.expression).kind === ts.SyntaxKind.SuperKeyword) {
    return superEffects(state, summaries, call, owner);
  }
  const callee = unwrapExpression(call.expression);
  if (isIteratorAdvance(state, summaries, callee)) {
    return emptyCallEffects();
  }
  const resolved = resolveTargets(dispatchFor(state, summaries), call.expression);
  if (resolved.targets.length > 0) {
    return resolvedCallEffects(state, summaries, resolved, call, owner);
  }
  const parameterIndex = parameterCallableIndex(state, call.expression, owner);
  if (parameterIndex !== undefined) {
    return { flows: [], writes: [], parameterCalls: [{
      parameterIndex, node: call.expression,
      argumentFacts: call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call)),
    }] };
  }
  const known = libraryCall(call, state.model);
  return known ? libraryEffects(state, summaries, call, owner, known) : unknownEffects(call.expression, owner, "calls unresolved callable");
}

function isIteratorAdvance(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, callee: ts.Expression): boolean {
  return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    ["next", "return", "throw"].includes(methodName(callee) ?? "") && isKnownIterator(state, summaries, callee.expression);
}

function unknownEffects(node: ts.Node, owner: EffectOwner, description: string): CallEffects {
  return { flows: [{ kind: "unknown", node, owner, description }], writes: [], parameterCalls: [] };
}

function combineEffects(groups: readonly CallEffects[]): CallEffects {
  return {
    flows: groups.flatMap((group) => group.flows),
    writes: groups.flatMap((group) => group.writes),
    parameterCalls: groups.flatMap((group) => group.parameterCalls),
  };
}

function resolvedCallEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  resolved: Targets,
  call: ts.CallExpression,
  owner: EffectOwner,
): CallEffects {
  const sites = resolved.targets.every(isGenerator) ? generatorSites(state, call, owner) : [call.expression];
  const callee = unwrapExpression(call.expression);
  const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
    ? storageFactForExpression(state, summaries, callee.expression, owner, call) : undefined;
  const captures = capturesForExpression(state, summaries, call.expression, owner, new Set());
  const groups = sites.flatMap((site) => resolved.targets.map((target) => {
    const summary = summaries.get(target);
    return summary ? instantiateCallableSummary(state, summaries, summary, call.arguments, site, owner, new Set(), receiver, captures)
      : unknownEffects(site, owner, "calls unresolved callable");
  }));
  if (!resolved.complete) {
    groups.push(unknownEffects(call.expression, owner, "calls overridable method"));
  }
  return combineEffects(groups);
}

function capturesForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
  owner: EffectOwner,
  seen: ReadonlySet<Binding>,
): ReadonlyMap<Binding, StorageFact> {
  const value = unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    return factoryCaptures(state, summaries, value, owner);
  }
  if (!ts.isIdentifier(value)) {
    return new Map();
  }
  const binding = state.model.resolve(value);
  if (!binding || seen.has(binding) || !inside(binding.scope.node, owner)) {
    return new Map();
  }
  const next = new Set(seen).add(binding);
  return joinCaptures(bindingAssignments(binding).map((assignment) => assignment.value
    ? capturesForExpression(state, summaries, assignment.value, owner, next) : new Map()));
}

function joinCaptures(groups: readonly ReadonlyMap<Binding, StorageFact>[]): ReadonlyMap<Binding, StorageFact> {
  const captures = new Map<Binding, StorageFact>();
  for (const group of groups) {
    for (const [binding, fact] of group) {
      captures.set(binding, joinStorageFacts([captures.get(binding) ?? privateFact, fact]));
    }
  }
  return captures;
}

function factoryCaptures(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): ReadonlyMap<Binding, StorageFact> {
  const factories = resolveTargets(dispatchFor(state, summaries), call.expression).targets;
  const actualFact = (index: number) => call.arguments[index]
    ? storageFactForExpression(state, summaries, call.arguments[index], owner, call) : unknownFact;
  return joinCaptures(factories.map((factory) => factoryRelativeCaptures(state, summaries, factory, actualFact)));
}

function factoryRelativeCaptures(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  factory: EffectOwner,
  actualFact: (index: number) => StorageFact,
): ReadonlyMap<Binding, StorageFact> {
  const returned = summaries.get(factory)?.returnedCallables ?? [];
  return joinCaptures(returned.map((closure) => new Map((summaries.get(closure)?.flows ?? []).flatMap((flow) => {
    if (!flow.binding || !inside(flow.binding.scope.node, factory)) {
      return [];
    }
    const relative = storageFactForBinding(state, summaries, flow.binding, factory, closure);
    return [[flow.binding, instantiateStorageFact(relative, actualFact)]];
  }))));
}

function libraryEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: LibraryCall,
): CallEffects {
  if (known.kind === "effect") {
    return emptyCallEffects();
  }
  const groups: CallEffects[] = [];
  for (const index of known.callbacks) {
    const callback = call.arguments[index];
    if (callback) {
      groups.push(callbackEffects(state, summaries, callback, libraryCallbackFacts(state, summaries, call, owner, known), call.expression, owner));
    }
  }
  if (known.kind === "mutating") {
    groups.push(mutatingMethodEffects(state, summaries, call, owner, known));
  }
  return combineEffects(groups);
}

function libraryCallbackFacts(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
): StorageFact[] {
  const target = libraryTarget(call, known);
  const receiver = target ? storageFactForExpression(state, summaries, target, owner, call) : privateFact;
  const element = { outer: receiver.reachable, reachable: receiver.reachable };
  const name = methodName(unwrapExpression(call.expression));
  if (name === "reduce" || name === "reduceRight") {
    const initial = call.arguments[1] ? storageFactForExpression(state, summaries, call.arguments[1], owner, call) : element;
    return [joinStorageFacts([initial, element]), element, privateFact, receiver];
  }
  if (name === "sort" || name === "toSorted") {
    return [element, element];
  }
  return [element, privateFact, receiver];
}

function callbackEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  callback: ts.Expression,
  facts: readonly StorageFact[],
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  const resolved = resolveTargets(dispatchFor(state, summaries), callback);
  const effects = instantiateCallbackTargets(state, summaries, resolved.targets, facts, node, owner, new Set());
  if (resolved.complete) {
    return effects;
  }
  const index = parameterCallableIndex(state, callback, owner);
  if (index !== undefined) {
    effects.parameterCalls.push({ parameterIndex: index, node, argumentFacts: facts });
    return effects;
  }
  return combineEffects([effects, unknownEffects(node, owner, "calls unresolved callable")]);
}

function instantiateCallableSummary(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  summary: CallableSummary,
  actuals: readonly ts.Expression[],
  node: ts.Node,
  owner: EffectOwner,
  seen = new Set<string>(),
  receiver?: StorageFact,
  captures: ReadonlyMap<Binding, StorageFact> = new Map(),
): CallEffects {
  const key = `${ownerKey(summary.owner)}:${actuals.map((actual) => actual.getStart()).join(",")}`;
  if (seen.has(key)) {
    return emptyCallEffects();
  }
  const nextSeen = new Set(seen).add(key);
  const active = <T extends { readonly defaultParameterIndex?: number }>(effects: readonly T[]) =>
    effects.filter((effect) => defaultMayRun(effect.defaultParameterIndex, actuals, state.model));
  const rebound = active(summary.flows).map((flow) => reboundFlow(state, summaries, flow, node, owner, receiver, captures));
  const flows = rebound.flatMap((effect) => effect.flows);
  const writes = rebound.flatMap((effect) => effect.writes);
  const parameterCalls: ParameterCall[] = [];
  const spread = actuals.findIndex(ts.isSpreadElement);
  const actualFact = (index: number) => {
    if (spread >= 0 && index >= spread) {
      return unknownFact;
    }
    const actual = actuals[index];
    return actual
      ? storageFactForExpression(state, summaries, actual, owner, node)
      : { outer: ["unknown"], reachable: ["unknown"] } satisfies StorageFact;
  };
  const writeEffects = instantiateParameterWrites(state, active(summary.parameterWrites), actuals, actualFact, node, owner);
  flows.push(...writeEffects.flows);
  writes.push(...writeEffects.writes);
  const callbackEffects = instantiateParameterCalls(
    state,
    summaries,
    active(summary.parameterCalls),
    actuals,
    actualFact,
    node,
    owner,
    nextSeen,
  );
  flows.push(...callbackEffects.flows);
  writes.push(...callbackEffects.writes);
  parameterCalls.push(...callbackEffects.parameterCalls);
  return { flows, writes, parameterCalls };
}

function defaultMayRun(index: number | undefined, actuals: readonly ts.Expression[], model: ScopeModel): boolean {
  if (index === undefined || !actuals[index]) {
    return true;
  }
  if (actuals.slice(0, index + 1).some(ts.isSpreadElement)) {
    return true;
  }
  const value = unwrapExpression(actuals[index]);
  if (isDefinedLiteral(value)) {
    return false;
  }
  return ts.isIdentifier(value) && !model.resolve(value) ? value.text === "undefined" : true;
}

function isDefinedLiteral(value: ts.Expression): boolean {
  return isScalarLiteral(value) || ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value) || isFunctionLike(value);
}

function reboundFlow(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  flow: ImplicitFlow,
  node: ts.Node,
  owner: EffectOwner,
  receiver?: StorageFact,
  captures: ReadonlyMap<Binding, StorageFact> = new Map(),
): CallEffects {
  if (flow.receiver && receiver) {
    return receiverFlow(state, flow, receiver, node, owner);
  }
  const captured = flow.binding && captures.get(flow.binding);
  if (captured) {
    return capturedFlow(state, flow, captured, node, owner);
  }
  if (flow.binding && inside(flow.binding.scope.node, owner)) {
    return ownedBindingFlow(state, summaries, flow, flow.binding, node, owner);
  }
  return { flows: [{ ...flow, node, owner, defaultParameterIndex: undefined }], writes: [], parameterCalls: [] };
}

function ownedBindingFlow(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  flow: ImplicitFlow,
  binding: Binding,
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  if (flow.access !== "contents") {
    return emptyCallEffects();
  }
  const fact = storageFactForBinding(state, summaries, binding, owner, node);
  return mutationEffectsFromFact(state, fact, flow.path ?? "outer", node, owner,
    isParameterOf(binding, owner) ? `mutates argument ${binding.name}` : `mutates caller-owned value ${binding.name}`);
}

function capturedFlow(state: AnalysisState, flow: ImplicitFlow, fact: StorageFact, node: ts.Node, owner: EffectOwner): CallEffects {
  if (flow.access === "contents") {
    return mutationEffectsFromFact(state, fact, flow.path ?? "outer", node, owner, flow.description, false, true);
  }
  return flow.access === "read" ? receiverFlow(state, { ...flow, receiver: "read" }, fact, node, owner) : emptyCallEffects();
}

function receiverFlow(state: AnalysisState, flow: ImplicitFlow, receiver: StorageFact, node: ts.Node, owner: EffectOwner): CallEffects {
  if (flow.receiver === "write") {
    return mutationEffectsFromFact(state, receiver, flow.path ?? "outer", node, owner, "mutates receiver state", false, true);
  }
  const origins = originsForPath(receiver, flow.path ?? "outer");
  const effects = emptyCallEffects();
  if (hasExternalOrigin(origins)) {
    effects.flows.push({ kind: "input", node, owner, description: flow.description });
  }
  if (hasUnknownOrigin(origins)) {
    effects.flows.push({ kind: "unknown", node, owner, description: flow.description });
  }
  if (hasReceiverOrigin(origins)) {
    effects.flows.push({ ...flow, node, owner, defaultParameterIndex: undefined });
  }
  return effects;
}

function instantiateParameterWrites(
  state: AnalysisState,
  parameterWrites: readonly ParameterWrite[],
  actuals: readonly ts.Expression[],
  actualFact: (index: number) => StorageFact,
  node: ts.Node,
  owner: EffectOwner,
): Pick<CallEffects, "flows" | "writes"> {
  return combineEffects(parameterWrites.map((write) => {
    const actual = actuals[write.parameterIndex];
    if (!actual) {
      return unknownEffects(node, owner, "calls writable parameter without an argument");
    }
    return mutationEffectsFromFact(state, actualFact(write.parameterIndex), write.path, node, owner,
      `mutates caller-owned value ${actual.getText(state.sourceFile)}`, false, true);
  }));
}

function instantiateParameterCalls(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  parameterCalls: readonly ParameterCall[],
  actuals: readonly ts.Expression[],
  actualFact: (index: number) => StorageFact,
  node: ts.Node,
  owner: EffectOwner,
  seen: Set<string>,
): CallEffects {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const forwardedCalls: ParameterCall[] = [];
  for (const parameterCall of parameterCalls) {
    const callback = actuals[parameterCall.parameterIndex];
    const argumentFacts = parameterCall.argumentFacts.map((fact) => instantiateStorageFact(fact, actualFact));
    if (!callback) {
      flows.push({ kind: "unknown", node, owner, description: "calls unresolved callable" });
      continue;
    }
    const known = libraryCallback(callback, state.model);
    if (known) {
      if (known.kind === "effect") {
        flows.push({ kind: known.flow[0], node, owner, description: known.flow[1] });
      }
      continue;
    }
    const callbackTargets = callableTargets(state, summaries, callback);
    if (!callbackTargets) {
      const callbackParameterIndex = parameterCallableIndex(state, callback, owner);
      if (callbackParameterIndex === undefined) {
        flows.push({ kind: "unknown", node, owner, description: "calls unresolved callable" });
      } else {
        forwardedCalls.push({ parameterIndex: callbackParameterIndex, node, argumentFacts });
      }
      continue;
    }
    const effects = instantiateCallbackTargets(state, summaries, callbackTargets, argumentFacts, node, owner, seen);
    flows.push(...effects.flows);
    writes.push(...effects.writes);
    forwardedCalls.push(...effects.parameterCalls);
  }
  return { flows, writes, parameterCalls: forwardedCalls };
}

function instantiateCallbackTargets(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  targets: readonly EffectOwner[],
  argumentFacts: readonly StorageFact[],
  node: ts.Node,
  owner: EffectOwner,
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
      owner,
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
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  summary: CallableSummary,
  actualFacts: readonly StorageFact[],
  node: ts.Node,
  owner: EffectOwner,
  seen: Set<string>,
): CallEffects {
  const key = `${ownerKey(summary.owner)}:${JSON.stringify(actualFacts)}`;
  if (seen.has(key)) {
    return emptyCallEffects();
  }
  const rebound = summary.flows.map((flow) => reboundFlow(state, summaries, flow, node, owner));
  const actualFact = (index: number) => actualFacts[index] ?? unknownFact;
  const writes = summary.parameterWrites.map((write) => mutationEffectsFromFact(state, actualFact(write.parameterIndex),
    write.path, node, owner, "mutates caller-owned callback argument", false, true));
  const unresolved = summary.parameterCalls.length > 0 ? [unknownEffects(node, owner, "calls unresolved callable")] : [];
  return combineEffects([...rebound, ...writes, ...unresolved]);
}

function mutatingMethodEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
): CallEffects {
  const target = libraryTarget(call, known);
  if (!target || ts.isIdentifier(unwrapExpression(target)) || rootIsThis(target)) {
    return emptyCallEffects();
  }
  const fact = storageFactForExpression(state, summaries, target, owner, call);
  const indexes = parameterOriginIndexes(fact.outer);
  const name = methodName(unwrapExpression(call.expression));
  return mutationEffectsFromFact(state, fact, "outer", call.expression, owner,
    indexes.length === 1 ? `mutates argument ${parameterName(owner, indexes[0])}` : `mutates receiver of ${name ?? "call"}`);
}

function constructorEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
  actuals: readonly ts.Expression[],
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  const classes = classTargets(state.model, expression);
  if (!classes) {
    return isPureConstructor(globalName(expression, state.model)) ? emptyCallEffects()
      : unknownEffects(node, owner, "constructs unresolved class");
  }
  return combineEffects(classes.map((created) => {
    const summary = summaries.get(explicitConstructor(created) ?? created);
    return summary ? instantiateCallableSummary(state, summaries, summary, actuals, node, owner, new Set(), privateFact)
      : unknownEffects(node, owner, "constructs unresolved class");
  }));
}

function superEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): CallEffects {
  const enclosing = enclosingClass(call);
  const base = enclosing && baseClassExpression(enclosing);
  return base ? constructorEffects(state, summaries, base, call.arguments, call.expression, owner)
    : unknownEffects(call.expression, owner, "constructs unresolved base class");
}

function accessorEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Expression,
  owner: EffectOwner,
): CallEffects {
  const wrapped = outerExpression(node);
  const parent = wrapped.parent;
  if (ts.isCallExpression(parent) && parent.expression === wrapped) {
    return emptyCallEffects();
  }
  return combineEffects(accessorKinds(wrapped).map((kind) => accessorKindEffects(state, summaries, node, owner, kind)));
}

function accessorKinds(node: ts.Expression): readonly ("get" | "set")[] {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? ["set"] : ["get", "set"];
  }
  return isIncrement(parent) ? ["get", "set"] : ["get"];
}

function isIncrement(node: ts.Node): boolean {
  return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken);
}

function accessorKindEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Expression,
  owner: EffectOwner,
  kind: "get" | "set",
): CallEffects {
  const resolved = memberTargets(dispatchFor(state, summaries), node, kind);
  if (resolved.targets.length === 0) {
    return emptyCallEffects();
  }
  const receiver = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    ? storageFactForExpression(state, summaries, node.expression, owner, node) : unknownFact;
  const parent = outerExpression(node).parent;
  const actuals = kind === "set" && ts.isBinaryExpression(parent) ? [parent.right] : [];
  const groups = resolved.targets.flatMap((target) => {
    const summary = summaries.get(target);
    return summary ? [instantiateCallableSummary(state, summaries, summary, actuals, node, owner, new Set(), receiver)] : [];
  });
  if (!resolved.complete) {
    groups.push(unknownEffects(node, owner, "accesses unresolved accessor"));
  }
  return combineEffects(groups);
}

function generatorSites(state: AnalysisState, call: ts.CallExpression, owner: EffectOwner): ts.Node[] {
  const direct = forcingSite(state.model, outerExpression(call));
  if (direct) {
    return [direct];
  }
  const parent = outerExpression(call).parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const binding = state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parent));
    return binding ? bindingForcingSites(state, binding, owner, new Set()) : [];
  }
  return [];
}

function bindingForcingSites(state: AnalysisState, binding: Binding, owner: EffectOwner, seen: ReadonlySet<Binding>): ts.Node[] {
  if (seen.has(binding)) {
    return [];
  }
  const sites: ts.Node[] = [];
  const next = new Set(seen).add(binding);
  for (const reference of binding.references) {
    if (!inside(reference, owner)) {
      continue;
    }
    const site = forcingSite(state.model, outerExpression(reference));
    if (site) {
      sites.push(site);
    }
    const parent = outerExpression(reference).parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const alias = state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parent));
      if (alias) {
        sites.push(...bindingForcingSites(state, alias, owner, next));
      }
    }
  }
  return sites;
}

function forcingSite(model: ScopeModel, expression: ts.Expression): ts.Node | undefined {
  const parent = expression.parent;
  if (isIterationParent(parent, expression)) {
    return parent;
  }
  if (ts.isVariableDeclaration(parent) && !ts.isIdentifier(parent.name)) {
    return parent;
  }
  return explicitForcingSite(model, expression);
}

function isIterationParent(parent: ts.Node, expression: ts.Expression): boolean {
  return (ts.isForOfStatement(parent) && parent.expression === expression) || ts.isSpreadElement(parent) ||
    (ts.isYieldExpression(parent) && parent.asteriskToken !== undefined);
}

function explicitForcingSite(model: ScopeModel, expression: ts.Expression): ts.Node | undefined {
  const parent = expression.parent;
  if (ts.isCallExpression(parent) && globalName(parent.expression, model) === "Array.from" && parent.arguments[0] === expression) {
    return parent.expression;
  }
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      ["next", "return", "throw"].includes(methodName(parent) ?? "")) {
    return outerExpression(parent).parent;
  }
  return undefined;
}

function isKnownIterator(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, seen: ReadonlySet<Binding> = new Set()): boolean {
  const value = unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    const targets = callableTargets(state, summaries, value.expression);
    return targets !== undefined && targets.length > 0 && targets.every(isGenerator);
  }
  if (!ts.isIdentifier(value)) {
    return false;
  }
  const binding = state.model.resolve(value);
  if (!binding || seen.has(binding)) {
    return false;
  }
  const assignments = bindingAssignments(binding);
  return assignments.length > 0 && assignments.every((assignment) => assignment.value !== undefined &&
    isKnownIterator(state, summaries, assignment.value, new Set(seen).add(binding)));
}

type SummaryDraft = {
  flows: ImplicitFlow[];
  parameterWrites: ParameterWrite[];
  parameterCalls: ParameterCall[];
  returnedAliases: StorageFact[];
  returnedCallables: EffectOwner[];
  opaqueReturn: boolean;
};

function summarizeCallable(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  owner: EffectOwner,
  includeThis: boolean,
): CallableSummary {
  const draft: SummaryDraft = {
    flows: [], parameterWrites: [], parameterCalls: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false,
  };
  function visit(node: ts.Node): void {
    const deferred = deferredChildren(node, owner);
    if (deferred !== undefined) {
      deferred.forEach(visit);
      return;
    }
    appendEffects(draft, nodeEffects(state, summaries, node, owner, includeThis), defaultParameterIndexFor(node, owner));
    const returned = returnedExpression(node, owner);
    if (returned) {
      appendReturn(state, summaries, draft, returned, owner);
    }
    const reachable = reachableChildren(node);
    if (reachable) {
      reachable.forEach(visit);
    } else {
      ts.forEachChild(node, visit);
    }
  }
  executionRoots(owner).forEach(visit);
  appendEffects(draft, inheritedConstructorEffects(state, summaries, owner));
  return {
    owner,
    flows: uniqueFlows(draft.flows),
    parameterWrites: uniqueWrites(draft.parameterWrites),
    parameterCalls: uniqueParameterCalls(draft.parameterCalls),
    returnedAliases: uniqueFacts(draft.returnedAliases),
    returnedCallables: uniqueCallables(draft.returnedCallables),
    opaqueReturn: draft.opaqueReturn,
  };
}

function appendEffects(draft: SummaryDraft, effects: CallEffects, defaultParameterIndex?: number): void {
  draft.flows.push(...effects.flows.map((flow) => ({ ...flow, defaultParameterIndex: defaultParameterIndex ?? flow.defaultParameterIndex })));
  draft.parameterWrites.push(...effects.writes.map((write) => ({ ...write, defaultParameterIndex: defaultParameterIndex ?? write.defaultParameterIndex })));
  draft.parameterCalls.push(...effects.parameterCalls.map((call) => ({ ...call, defaultParameterIndex: defaultParameterIndex ?? call.defaultParameterIndex })));
}

function defaultParameterIndexFor(node: ts.Node, owner: EffectOwner): number | undefined {
  const index = ownerParameters(owner).findIndex((parameter) => parameter.initializer && inside(node, parameter.initializer));
  return index >= 0 ? index : undefined;
}

function nodeEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Node,
  owner: EffectOwner,
  includeThis: boolean,
): CallEffects {
  const mutation = mutationEffectsFor(state, summaries, node, owner);
  return combineEffects([
    { flows: directFlowsFor(state, node, owner, includeThis), writes: [], parameterCalls: [] },
    { ...mutation, parameterCalls: [] },
    invocationEffects(state, summaries, node, owner),
    evaluationEffects(state, summaries, node, owner),
  ]);
}

function invocationEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  if (ts.isCallExpression(node)) {
    return callEffects(state, summaries, node, owner);
  }
  if (ts.isNewExpression(node)) {
    return constructorEffects(state, summaries, node.expression, node.arguments ?? [], node.expression, owner);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return accessorEffects(state, summaries, node, owner);
  }
  return ts.isTaggedTemplateExpression(node) ? taggedTemplateEffects(state, summaries, node, owner) : emptyCallEffects();
}

function taggedTemplateEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.TaggedTemplateExpression,
  owner: EffectOwner,
): CallEffects {
  const resolved = resolveTargets(dispatchFor(state, summaries), node.tag);
  const substitutions = ts.isTemplateExpression(node.template) ? node.template.templateSpans.map((span) => span.expression) : [];
  const facts = [privateFact, ...substitutions.map((value) => storageFactForExpression(state, summaries, value, owner, node))];
  const effects = instantiateCallbackTargets(state, summaries, resolved.targets, facts, node.tag, owner, new Set());
  return resolved.complete ? effects : combineEffects([effects, unknownEffects(node.tag, owner, "calls unresolved callable")]);
}

function evaluationEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  return combineEffects(protocolExpressions(node, state.model).map(({ expression, protocol }) => {
    if (protocol === "iterate" && isKnownIterator(state, summaries, expression)) {
      return emptyCallEffects();
    }
    if (protocol === "await" && isHotAsyncCall(state, summaries, expression)) {
      return emptyCallEffects();
    }
    return supportsProtocol(state.model, expression, protocol) ? emptyCallEffects()
      : unknownEffects(node, owner, `uses unresolved ${protocol} protocol`);
  }));
}

function isHotAsyncCall(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  const targets = callableTargets(state, summaries, value.expression);
  return targets !== undefined && targets.length > 0 && targets.every((target) =>
    ts.canHaveModifiers(target) && ts.getModifiers(target)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function deferredChildren(node: ts.Node, owner: EffectOwner): readonly ts.Node[] | undefined {
  if (ts.isTypeNode(node) || ts.isExportDeclaration(node)) {
    return [];
  }
  if (node !== owner && isFunctionLike(node)) {
    return definitionExpressions(node);
  }
  return isInstanceField(node) ? definitionExpressions(node) : undefined;
}

function definitionExpressions(node: ts.Node): readonly ts.Expression[] {
  const computed = (isFunctionLike(node) || ts.isPropertyDeclaration(node)) && node.name && ts.isComputedPropertyName(node.name)
    ? [node.name.expression] : [];
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  return [...computed, ...decorators.map((decorator) => decorator.expression)];
}

function reachableChildren(node: ts.Node): readonly ts.Node[] | undefined {
  if (ts.isIfStatement(node)) {
    return conditionalChildren(node.expression, node.thenStatement, node.elseStatement);
  }
  return ts.isConditionalExpression(node) ? conditionalChildren(node.condition, node.whenTrue, node.whenFalse) : undefined;
}

function conditionalChildren(condition: ts.Expression, whenTrue: ts.Node, whenFalse: ts.Node | undefined): readonly ts.Node[] {
  const value = literalBooleanValue(condition);
  const selected = value === true ? [whenTrue] : value === false ? [] : [whenTrue];
  return [condition, ...selected, ...(value !== true && whenFalse ? [whenFalse] : [])];
}

function executionRoots(owner: EffectOwner): readonly ts.Node[] {
  if (ts.isClassLike(owner)) {
    return instanceInitializers(owner);
  }
  const enclosing = ts.isConstructorDeclaration(owner) ? enclosingClass(owner) : undefined;
  return [owner, ...(enclosing ? instanceInitializers(enclosing) : [])];
}

function inheritedConstructorEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  owner: EffectOwner,
): CallEffects {
  const base = ts.isClassLike(owner) ? baseClassExpression(owner) : undefined;
  if (!base) {
    return emptyCallEffects();
  }
  const parents = classTargets(state.model, base);
  if (!parents) {
    return isPureConstructor(globalName(base, state.model)) ? emptyCallEffects()
      : unknownEffects(base, owner, "constructs unresolved base class");
  }
  return combineEffects(parents.map((parent) => {
    const summary = summaries.get(explicitConstructor(parent) ?? parent);
    return summary ? {
      flows: summary.flows.flatMap((flow) => reboundFlow(state, summaries, flow, base, owner, privateFact).flows
        .map((rebound) => ({ ...rebound, defaultParameterIndex: flow.defaultParameterIndex }))),
      writes: summary.parameterWrites.map((write) => ({ ...write, node: base })),
      parameterCalls: summary.parameterCalls.map((call) => ({ ...call, node: base })),
    } : unknownEffects(base, owner, "constructs unresolved base class");
  }));
}

function returnedExpression(node: ts.Node, owner: EffectOwner): ts.Expression | undefined {
  if (ts.isReturnStatement(node)) {
    return node.expression;
  }
  return ts.isArrowFunction(owner) && !ts.isBlock(owner.body) && node === owner.body ? owner.body : undefined;
}

function appendReturn(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  draft: SummaryDraft,
  expression: ts.Expression,
  owner: EffectOwner,
): void {
  draft.returnedAliases.push(...returnedStorageFactsForExpression(state, summaries, expression, owner));
  const returned = returnedCallablesForExpression(state, summaries, expression);
  draft.returnedCallables.push(...returned.targets);
  draft.opaqueReturn ||= !returned.complete;
}

function uniqueFlows(flows: readonly ImplicitFlow[]): readonly ImplicitFlow[] {
  const seen = new Set<string>();
  return flows.filter((flow) => {
    const key = `${ownerKey(flow.owner)}:${flow.kind}:${flow.description}`;
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
    flows: summary.flows.map((flow) => [flow.kind, flow.description, flow.node.getStart(), flow.defaultParameterIndex]).sort(),
    writes: summary.parameterWrites.map((write) => [write.parameterIndex, write.path, write.description, write.node.getStart(), write.defaultParameterIndex]).sort(),
    calls: summary.parameterCalls.map((call) => [call.parameterIndex, call.node.getStart(), call.argumentFacts, call.defaultParameterIndex]).sort(),
    aliases: summary.returnedAliases.map((fact) => [fact.outer, fact.reachable]).sort(),
    opaque: summary.opaqueReturn,
    returns: summary.returnedCallables.map((node) => node.pos).sort((left, right) => left - right),
  });
}

function analyzeImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const model = analyzeScopes(sourceFile);
  const state = collectCallables(sourceFile, model, includeThis);
  let summaries = new Map<EffectOwner, CallableSummary>(state.callables.map((owner) => [
    owner,
    { owner, flows: [], parameterWrites: [], parameterCalls: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false },
  ]));
  let converged = false;
  for (let index = 0; index < state.callables.length + 8; index += 1) {
    state.summaries = summaries;
    let changed = false;
    const sharedCount = state.sharedBindings.size;
    const next = new Map<EffectOwner, CallableSummary>();
    for (const owner of state.callables) {
      const summary = summarizeCallable(state, summaries, owner, includeThis);
      shareExposedReturns(state, summary);
      next.set(owner, summary);
      changed ||= summaryKey(summary) !== summaryKey(summaries.get(owner) ?? summary);
    }
    summaries = next;
    if (!changed && sharedCount === state.sharedBindings.size) {
      converged = true;
      break;
    }
  }
  const flows: ImplicitFlow[] = [];
  for (const summary of summaries.values()) {
    if (!converged) {
      flows.push(...unknownEffects(summary.owner, summary.owner, "has effects this analysis did not resolve").flows);
    }
    flows.push(...summary.flows);
    flows.push(...summary.parameterWrites.map((write) => ({
      kind: "output" as const,
      node: write.node,
      owner: summary.owner,
      description: write.description,
    })));
    flows.push(...summary.parameterCalls.map((call) => ({
      kind: "unknown" as const,
      node: call.node,
      owner: summary.owner,
      description: "calls unresolved callable",
    })));
  }
  return [...uniqueFlows(flows)];
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
