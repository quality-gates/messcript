// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { globalName } from "../ast/global-reference";
import { isFunctionLike, isFunctionLikeWithBody } from "../ast/functions";
import { methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { analyzeScopes, isAmbient, writeTargets } from "../ast/scopes";
import type { Binding, ScopeModel, Write } from "../ast/scopes";
import { reachableChildren } from "./control-flow";
import { bindingAssignments, canReachSite, inside, referenceAssignment, unconditional } from "./assignments";
import { callableTargets as resolveTargets, memberTargets, type Dispatch, type Targets } from "./dispatch";
import { classTargets } from "./shapes";
import { ambientFlow, isPureConstructor, iteratedArgument, libraryCall, libraryCallback, movesElements, type LibraryCall, type LibraryStorage } from "./library";
import { protocolExpressions, supportsProtocol } from "./protocols";
import { readSites, storageSlot, writeAffectsRead, type ReadSite } from "./reads";
import {
  baseClassExpression, collectOwners, enclosingClass, explicitConstructor, instanceInitializers, isConstruction,
  isGenerator, isInstanceField, ownerKey, ownerParameters, type EffectOwner,
} from "./owners";
import {
  expressionStorageFact,
  externalBindingOrigin,
  nodeKey,
  storageFactAt,
  type StorageInsertion,
  type StorageResolver,
} from "./ownership";
import {
  arrayIndexForSlot,
  elementFact,
  externalProjection,
  memberStorageFact,
  mapStorageFact,
  hasExternalOrigin,
  hasReceiverOrigin,
  hasUnknownOrigin,
  freshStorageFact,
  allocatedFact,
  shallowStorageFact,
  invokedStorageFact,
  isCellAllocation,
  joinStorageFacts,
  joinStorageOrigins,
  originsForPath,
  parameterOriginIndexes,
  parameterProjection,
  type StorageFact,
  type StorageOrigin,
  type StoragePath,
} from "./storage";

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
  /** The write in a deeper callee that this flow forwards; set once a flow passes through a call it does not own. */
  writeNode?: ts.Node;
  /** The external storage an output flow mutates, so a caller that owns one of those bindings can re-resolve it. */
  origins?: readonly StorageOrigin[];
  reads?: readonly ReadSite[];
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
  readonly storageInsertions: readonly StorageInsertion[];
  readonly returnedAliases: readonly StorageFact[];
  readonly returnedCallables: readonly EffectOwner[];
  readonly opaqueReturn: boolean;
  readonly returnedRuns?: CallEffects;
};

type StorageInvocation = {
  readonly call: ts.CallExpression | ts.NewExpression;
  readonly callable: ts.Expression;
  readonly argumentFact: (index: number) => StorageFact;
};

type CallEffects = {
  readonly flows: ImplicitFlow[];
  readonly writes: ParameterWrite[];
  readonly parameterCalls: ParameterCall[];
};

type SharedWrite = { readonly fact: StorageFact; readonly origin: StorageOrigin; readonly site: ts.Node; readonly slot?: string };

type AnalysisState = {
  readonly model: ScopeModel;
  readonly sourceFile: ts.SourceFile;
  readonly callables: readonly EffectOwner[];
  summaries: ReadonlyMap<EffectOwner, CallableSummary>;
  readonly factCache: Map<string, StorageFact>;
  readonly insertionCache: Map<string, readonly StorageInsertion[]>;
  readonly cycles: { count: number };
  readonly includeThis: boolean;
  readonly sharedBindings: Map<Binding, Set<string>>;
  readonly sharedLocalBindings: Map<Binding, Map<string, SharedWrite>>;
  readonly bindingOrigins: ReadonlyMap<StorageOrigin, Binding>;
  readonly arrayLiterals: ReadonlyMap<number, ts.ArrayLiteralExpression>;
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
    return shared || isExportedStorage(binding) || isAmbientStorage(binding, node) ? ["input", `reads ${node.text}`] : undefined;
  }
  return undefined;
}

function isAmbientStorage(binding: Binding, node: ts.Identifier): boolean {
  const member = memberAccessOn(node);
  return binding.declarations.some((declaration) => isAmbient(declaration.node) &&
    (ts.isVariableDeclaration(declaration.node) || (ts.isClassDeclaration(declaration.node) && !!member && !isThisMethodCall(member))));
}

function namespaceFlow(node: ts.Identifier, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const namespaces = namespaceDeclarations(node);
  if (namespaces.length === 0) {
    return undefined;
  }
  const member = memberAccessOn(node);
  if (isThisMethodCall(member)) {
    return undefined;
  }
  if (write && !write.viaCall) {
    return ["output", `writes ${node.text}`];
  }
  const name = member && methodName(member);
  return name !== undefined && namespaces.every((item) => namespaceConstant(item, name)) ? undefined : ["input", `reads ${node.text}`];
}

function namespaceDeclarations(node: ts.Identifier): ts.ModuleDeclaration[] {
  const found: ts.ModuleDeclaration[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isModuleDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === node.text) {
      found.push(child);
    }
    if (ts.isModuleDeclaration(child) || ts.isModuleBlock(child) || ts.isSourceFile(child)) {
      ts.forEachChild(child, visit);
    }
  };
  visit(node.getSourceFile());
  return found;
}

function namespaceConstant(namespace: ts.ModuleDeclaration, name: string): boolean {
  if (isAmbient(namespace) || !namespace.body || !ts.isModuleBlock(namespace.body)) {
    return false;
  }
  const declarations = namespace.body.statements.flatMap((statement) => namedDeclarations(statement, name));
  return declarations.length > 0 && declarations.every((declaration) =>
    !ts.isVariableDeclaration(declaration) ||
    (!!(declaration.parent.flags & ts.NodeFlags.Const) && !!declaration.initializer && isScalarLiteral(declaration.initializer)));
}

function namedDeclarations(statement: ts.Statement, name: string): ts.Node[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.filter((item) => ts.isIdentifier(item.name) && item.name.text === name);
  }
  const named = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  return named && statement.name && ts.isIdentifier(statement.name) && statement.name.text === name ? [statement] : [];
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

function thisFlow(node: ts.Node, write: Write | undefined): [ImplicitFlowKind, string] | undefined {
  const member = memberAccessOn(node);
  const memberName = member && methodName(member);
  const subject = memberName !== undefined ? `this.${memberName}` : "this";
  if (write && !write.viaCall) {
    return ["output", `writes ${subject}`];
  }
  return isThisMethodCall(member) ? undefined : ["input", `reads ${subject}`];
}

function writeOf(state: AnalysisState, node: ts.Node): Write | undefined {
  const write = state.model.writeOf(node);
  const call = write?.contents ? methodCallOn(node) : undefined;
  const resolved = call && resolveTargets(dispatchFor(state, state.summaries), call.expression);
  return resolved && resolved.complete && resolved.targets.length > 0 ? undefined : write;
}

function methodCallOn(node: ts.Node): ts.CallExpression | undefined {
  const member = ts.isExpression(node) ? memberAccessOn(node) : undefined;
  const callee = member && outerExpression(member);
  return callee && ts.isCallExpression(callee.parent) && callee.parent.expression === callee ? callee.parent : undefined;
}

function directFlowsFor(state: AnalysisState, node: ts.Node, owner: EffectOwner, includeThis: boolean): ImplicitFlow[] {
  const write = writeOf(state, node);
  if (ts.isIdentifier(node) && state.model.isReference(node)) {
    return identifierFlows(state, node, owner, write);
  }
  return directReceiverFlows(state, node, owner, includeThis, write);
}

function directReceiverFlows(state: AnalysisState, node: ts.Node, owner: EffectOwner, includeThis: boolean, write: Write | undefined): ImplicitFlow[] {
  if (!isRootExpression(node) || node.kind !== ts.SyntaxKind.ThisKeyword || isConstruction(owner)) {
    return [];
  }
  const flow = thisFlow(node, write);
  return flow ? withCompoundRead(write, {
    kind: includeThis ? flow[0] : "unknown", node, owner, description: flow[1], receiver: flow[0] === "output" ? "write" : "read",
    path: write ? writePath(node, write) : "outer", reads: write ? undefined : storageReadSites(state, node as ts.Expression),
  }) : [];
}

function identifierFlows(state: AnalysisState, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ImplicitFlow[] {
  const binding = state.model.resolve(node);
  if (!binding) {
    const flow = ambientFlow(node, write !== undefined) ?? namespaceFlow(node, write);
    return flow ? withCompoundRead(write, { kind: flow[0], node, owner, description: flow[1] }) : [];
  }
  return aliasOf(state.model, node) ? [] : boundFlows(state, binding, node, owner, write);
}

function boundFlows(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ImplicitFlow[] {
  const shared = bindingSharesRead(state, binding, node, owner);
  const direct = bindingFlow(binding, node, owner, write, shared);
  if (direct) {
    return accessFlows(direct, binding, node, owner, write);
  }
  const target = aliasTarget(state.model, binding, new Set());
  const aliased = target && bindingFlow(target, node, owner, write, shared || bindingSharesRead(state, target, node, owner));
  if (target && aliased) {
    return accessFlows(aliased, target, node, owner, write);
  }
  const read = !write && inside(binding.scope.node, owner) ? sharedStorageRead(state, node, owner) : undefined;
  return read ? [{ kind: "input", node, owner, description: `reads ${read.name}` }] : [];
}

function sharedStorageRead(state: AnalysisState, node: ts.Identifier, owner: EffectOwner): Binding | undefined {
  const fact = storageFactForExpression(state, state.summaries, node, owner, node);
  return externalReads(state, fact, storageReadSites(state, node), owner, false);
}

function externalReads(
  state: AnalysisState, fact: StorageFact, sites: readonly ReadSite[], owner: EffectOwner, exported: boolean,
): Binding | undefined {
  for (const site of sites) {
    for (let length = 0; length <= site.path.length; length += 1) {
      const origins = originsForPath(fact, length ? site.path.slice(0, length) : "outer");
      const read = origins.map((origin) => originBinding(state, origin)).find((external) => external &&
        ((exported && (isExportedStorage(external.binding) || isAmbientVariable(external.binding))) ||
          storageReadAffected(state, external.binding, { path: [...external.path, ...site.path.slice(length)], reference: site.reference }, owner)));
      if (read) {
        return read.binding;
      }
    }
  }
  return undefined;
}

function isAmbientVariable(binding: Binding): boolean {
  return binding.declarations.some((declaration) => isAmbient(declaration.node) && ts.isVariableDeclaration(declaration.node));
}

function accessFlows(flow: [ImplicitFlowKind, string], binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ImplicitFlow[] {
  return withCompoundRead(write, { kind: flow[0], node, owner, description: flow[1], ...bindingAccess(binding, node, write) });
}

/**
 * Tells if the reference initializes a constant alias of a constant, as log in const alias = log.
 * Copying a reference reads neither binding's contents, so the uses of the alias report the target instead.
 */
function aliasOf(model: ScopeModel, node: ts.Identifier): boolean {
  const expression = outerExpression(node);
  const declaration = expression.parent;
  return constantDeclaration(declaration) && declaration.initializer === expression && constantBinding(model.resolve(node));
}

function constantBinding(binding: Binding | undefined): binding is Binding {
  return !!binding && binding.declarations.length === 1 && constantDeclaration(binding.declarations[0].node);
}

function aliasTarget(model: ScopeModel, binding: Binding, seen: Set<Binding>): Binding | undefined {
  const declaration = binding.declarations[0]?.node;
  if (seen.has(binding) || !constantBinding(binding) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return undefined;
  }
  seen.add(binding);
  const value = unwrapExpression(declaration.initializer);
  const target = ts.isIdentifier(value) ? model.resolve(value) : undefined;
  if (!constantBinding(target)) {
    return undefined;
  }
  return aliasTarget(model, target, seen) ?? target;
}

function constantDeclaration(node: ts.Node): node is ts.VariableDeclaration {
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent) &&
    !!(node.parent.flags & ts.NodeFlags.Const);
}

function bindingSharesRead(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner): boolean {
  if (!state.sharedBindings.has(binding) && !state.sharedLocalBindings.has(binding) && !binding.mutated) {
    return false;
  }
  return storageReadSites(state, node).some((site) => storageReadAffected(state, binding, site, owner));
}

function storageReadAffected(state: AnalysisState, binding: Binding, site: ReadSite, owner: EffectOwner): boolean {
  return sharedMarkAffectsRead(state, binding, site) || capturedReadSharesMutation(state, binding, site, owner) ||
    directMutationAffectsRead(state, binding, site);
}

function storageReadSites(state: AnalysisState, node: ts.Expression, seen = new Set<string>()): ReadSite[] {
  return readSites(node, (site, index) => argumentReadSites(state, site, index, seen));
}

function argumentReadSites(
  state: AnalysisState, site: ts.CallExpression | ts.AccessExpression, index: number | "this", seen: Set<string>,
): ReadSite[] | undefined {
  const dispatch = dispatchFor(state, state.summaries);
  const resolved = ts.isCallExpression(site) ? resolveTargets(dispatch, site.expression) : memberTargets(dispatch, site, "set");
  if (!ts.isCallExpression(site) && resolved.targets.length === 0) {
    return [{ path: [], reference: true }];
  }
  if (index === -1 || !resolved.complete || resolved.targets.length === 0) {
    return undefined;
  }
  return resolved.targets.flatMap((target) => {
    const key = `${ownerKey(target)}:${index}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return index === "this" ? receiverReadSites(state, target, seen) : parameterReadSites(state, target, index, seen);
  });
}

function receiverReadSites(state: AnalysisState, target: EffectOwner, seen: Set<string>): ReadSite[] {
  if (ts.isArrowFunction(target) || isGenerator(target) || isConstruction(target)) {
    return [{ path: [], reference: false }];
  }
  const sites: ReadSite[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const write = writeOf(state, node);
      sites.push(...(write && !write.viaCall ? [] : storageReadSites(state, node as ts.Expression, seen)
        .map((site) => ({ path: site.path, reference: false }))));
    } else if (!(isFunctionLike(node) && !ts.isArrowFunction(node)) && !ts.isClassLike(node)) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(target, visit);
  return sites;
}

function parameterReadSites(state: AnalysisState, target: EffectOwner, index: number, seen: Set<string>): ReadSite[] {
  const parameter = ownerParameters(target)[index];
  const binding = parameter && state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parameter));
  if (!binding || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || isGenerator(target) || usesArguments(target)) {
    return [{ path: [], reference: false }];
  }
  return binding.references.flatMap((reference) => {
    if (enclosingFunction(reference) !== target) {
      return [{ path: [], reference: false }];
    }
    const write = writeOf(state, reference);
    return write && !write.viaCall ? [] : storageReadSites(state, reference, seen).map((site) => ({ path: site.path, reference: false }));
  });
}

function usesArguments(target: EffectOwner): boolean {
  const visit = (node: ts.Node): boolean => (ts.isIdentifier(node) && node.text === "arguments") ||
    (!(isFunctionLike(node) && !ts.isArrowFunction(node)) && !!ts.forEachChild(node, visit));
  return !!ts.forEachChild(target, visit);
}

function sharedMarkAffectsRead(state: AnalysisState, binding: Binding, site: ReadSite): boolean {
  const marks = state.sharedBindings.get(binding);
  return !!marks && [...marks].some((mark) => {
    const slots = JSON.parse(mark) as string[];
    return writeAffectsRead(site, slots.slice(0, -1), slots[slots.length - 1]);
  });
}

function capturedReadSharesMutation(state: AnalysisState, binding: Binding, site: ReadSite, owner: EffectOwner): boolean {
  const writes = state.sharedLocalBindings.get(binding);
  if (!writes || inside(binding.scope.node, owner)) {
    return false;
  }
  return [...writes.values()].some(({ fact, origin, slot }) =>
    Array.from({ length: site.path.length + 1 }, (_, length) => site.path.slice(0, length))
      .some((prefix) => originsForPath(fact, prefix.length ? prefix : "outer").includes(origin) && writeAffectsRead(site, prefix, slot)));
}

function selectedSlots(node: ts.Identifier): string[] {
  const slots: string[] = [];
  let current: ts.Expression = outerExpression(node);
  while ((ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current) {
    slots.push(storageSlot(current.parent) ?? "*");
    current = outerExpression(current.parent);
  }
  return slots;
}

function directMutationAffectsRead(state: AnalysisState, binding: Binding, site: ReadSite): boolean {
  if (!binding.mutated) {
    return false;
  }
  return binding.references.some((reference) => {
    const write = writeOf(state, reference);
    if (!write || write.viaCall || write.contents) {
      return false;
    }
    const prefix = selectedSlots(reference).slice(0, -1);
    return write.reassign || assignedSlots(state, reference).some((slot) => writeAffectsRead(site, prefix, slot));
  });
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

function writePath(node: ts.Expression, write: Write): "outer" | readonly string[] {
  const slots: string[] = [];
  let current: ts.Expression = outerExpression(node);
  while ((ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current) {
    slots.push(storageSlot(current.parent) ?? "*");
    current = outerExpression(current.parent);
  }
  return slots.length > 1 ? slots.slice(0, -1) : "outer";
}

function returnStorageResolver(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
): StorageResolver {
  const useCache = summaries === state.summaries;
  return {
    cache: useCache ? state.factCache : undefined,
    cycles: state.cycles,
    call: (call, owner, site, seen) =>
      ts.isCallExpression(call) ? joinedReturnFactForCall(state, summaries, call, owner, seen) : undefined,
    insertions: (owner, site) => {
      const key = `${nodeKey(owner)}:${nodeKey(site)}`;
      const cached = useCache ? state.insertionCache.get(key) : undefined;
      if (cached) {
        return cached;
      }
      const computed = (summaries.get(owner)?.storageInsertions ?? [])
        .filter((insertion) => canReachSite(insertion.node, owner, site))
        .map((insertion) => ({ ...insertion, replace: insertion.replace && insertion.node.end <= site.getStart() && unconditional(insertion.node, owner) }));
      if (useCache) {
        state.insertionCache.set(key, computed);
      }
      return computed;
    },
  };
}

function storageFactForExpression(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
  owner: EffectOwner,
  site: ts.Node,
  seen: ReadonlySet<Binding> = new Set(),
): StorageFact {
  const key = summaries === state.summaries && seen.size === 0 ? `e:${nodeKey(expression)}:${nodeKey(owner)}:${nodeKey(site)}` : undefined;
  const cached = key ? state.factCache.get(key) : undefined;
  if (cached) {
    return cached;
  }
  const fact = expressionStorageFact(state.model, expression, owner, site, returnStorageResolver(state, summaries), seen);
  if (key) {
    state.factCache.set(key, fact);
  }
  return fact;
}

function storageFactForBinding(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  binding: Binding,
  owner: EffectOwner,
  site: ts.Node,
): StorageFact {
  const id = binding.declarations[0]?.identifier.getStart() ?? -1;
  const key = summaries === state.summaries ? `b:${id}:${nodeKey(owner)}:${nodeKey(site)}` : undefined;
  const cached = key ? state.factCache.get(key) : undefined;
  if (cached) {
    return cached;
  }
  const fact = storageFactAt(state.model, binding, owner, site, new Set(), returnStorageResolver(state, summaries));
  if (key) {
    state.factCache.set(key, fact);
  }
  return fact;
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
  const write = writeOf(state, node);
  const binding = state.model.resolve(node);
  if (!write || write.reassign || write.viaCall || !binding) {
    return { flows: [], writes: [] };
  }
  const path = writePath(node, write);
  const fact = storageFactForBinding(state, summaries, binding, owner, node);
  if (!inside(binding.scope.node, owner)) {
    shareCapturedWrite(state, binding, node, owner, path, fact);
    return { flows: [], writes: [] };
  }
  return mutationEffectsFromFact(state, fact, path, node, owner, isParameterOf(binding, owner)
    ? `mutates argument ${node.text}`
    : `mutates caller-owned value ${node.text}`);
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
  slots?: readonly (string | undefined)[],
): CallEffects {
  const origins = originsForPath(fact, path);
  shareAliasedLocalBindings(state, origins, node, owner, slots);
  const writes = origins.flatMap((origin) => {
    const projection = parameterProjection(origin);
    return projection ? [{
      parameterIndex: projection.parameterIndex,
      path: projection.path.length ? projection.path : path,
      node,
      description: parameterDescription ? `mutates argument ${parameterName(owner, projection.parameterIndex)}` : description,
    }] : [];
  });
  return { flows: originFlows(state, origins, node, owner, description, receiverReported), writes, parameterCalls: [] };
}

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
    flows.push({ kind: "output", node, owner, description, origins: origins.filter((origin) => origin.startsWith("external:")) });
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
  const arrayLiterals = new Map<number, ts.ArrayLiteralExpression>();
  const collectArrays = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      arrayLiterals.set(node.getStart(), node);
    }
    ts.forEachChild(node, collectArrays);
  };
  collectArrays(sourceFile);
  return {
    model, sourceFile, callables: collectOwners(sourceFile), summaries: new Map(),
    factCache: new Map(), insertionCache: new Map(), cycles: { count: 0 }, includeThis,
    sharedBindings: new Map(), sharedLocalBindings: new Map(),
    bindingOrigins: new Map(model.bindings.map((binding) => [externalBindingOrigin(binding), binding])),
    arrayLiterals,
  };
}

function shareOrigins(state: AnalysisState, origins: readonly StorageOrigin[], slots: readonly string[] = ["*"]): void {
  for (const origin of origins) {
    const external = originBinding(state, origin);
    if (external) {
      const marks = state.sharedBindings.get(external.binding) ?? new Set<string>();
      slots.forEach((slot) => marks.add(JSON.stringify([...external.path, slot])));
      state.sharedBindings.set(external.binding, marks);
    }
  }
}

function originBinding(state: AnalysisState, origin: StorageOrigin): { binding: Binding; path: readonly string[] } | undefined {
  const projection = externalProjection(origin);
  const binding = projection && state.bindingOrigins.get(projection.base);
  return binding && projection ? { binding, path: projection.path } : undefined;
}

function shareCapturedWrite(
  state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, path: StoragePath, fact: StorageFact,
): void {
  for (const origin of originsForPath(fact, path)) {
    shareOrigins(state, [origin], capturedWriteSlots(state, binding, node, owner, path, origin));
  }
}

function capturedWriteSlots(
  state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, path: StoragePath, origin: StorageOrigin,
): readonly string[] {
  if (invocationsRecorded(state, owner, binding)) {
    return [];
  }
  const length = path === "outer" && origin === externalBindingOrigin(binding) ? literalArrayLength(binding) : undefined;
  if (length === undefined) {
    return ["*"];
  }
  const write = writeOf(state, node);
  const push = pushCallForMutation(node);
  const slots = write && !write.contents ? assignedSlots(state, node)
    : push ? pushSlots(push, owner, { lowerBound: length, exact: false }) : [undefined];
  return slots.map((slot) => slot ?? "*");
}

function invocationsRecorded(state: AnalysisState, owner: EffectOwner, binding: Binding): boolean {
  const name = ts.isFunctionDeclaration(owner) ? owner.name
    : ts.isVariableDeclaration(owner.parent) && owner.parent.initializer === owner && ts.isIdentifier(owner.parent.name)
      ? owner.parent.name : undefined;
  const callable = name && state.model.bindings.find((candidate) => candidate.declarations.some((declaration) => declaration.identifier === name));
  const scopeOwner = enclosingFunction(binding.scope.node);
  return !!callable && !!scopeOwner && !callable.mutated && callable.references.every((reference) =>
    reference === name || (ts.isCallExpression(reference.parent) && reference.parent.expression === reference &&
      inside(reference, scopeOwner) && !nestedFunctionBetween(reference, scopeOwner)));
}

function enclosingFunction(node: ts.Node): EffectOwner | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (isFunctionLike(current)) {
      return current as EffectOwner;
    }
  }
  return undefined;
}

function literalArray(state: AnalysisState, site: ts.Identifier): boolean {
  const binding = state.model.resolve(site);
  return !!binding && binding.declarations.every((declaration) => declaration.kind === "variable") &&
    literalArrayLength(binding) !== undefined;
}

function literalArrayLength(binding: Binding): number | undefined {
  const assignments = bindingAssignments(binding);
  const value = assignments.length === 1 && assignments[0].value ? unwrapExpression(assignments[0].value) : undefined;
  return value && ts.isArrayLiteralExpression(value) && !value.elements.some(ts.isSpreadElement) ? value.elements.length : undefined;
}

function assignedSlots(state: AnalysisState, site: ts.Identifier): readonly (string | undefined)[] {
  const access = outermostAccess(site);
  const member = unwrapExpression(access);
  const slot = ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member) ? storageSlot(member) : undefined;
  if (slot === "property:length") {
    return [slot, truncatedSlot(access)];
  }
  if (ts.isElementAccessExpression(member) && member.expression === outerExpression(site) && literalArray(state, site) &&
      appendIndex(state, member)) {
    return [`append:${appendStart(state, site, member)}`, "property:length"];
  }
  return arrayIndexForSlot(slot) === undefined ? [slot] : [slot, "property:length"];
}

function appendStart(state: AnalysisState, site: ts.Identifier, member: ts.ElementAccessExpression): number {
  const owner = enclosingFunction(site);
  const origin = owner ? soleOrigin(state, site, owner, member) : undefined;
  const length = origin === undefined ? undefined : literalAllocationLength(state, origin);
  return owner && origin !== undefined && length !== undefined ? priorPushStart(state, owner, member, origin, length)?.lowerBound ?? 0 : 0;
}

function soleOrigin(state: AnalysisState, identifier: ts.Identifier, owner: EffectOwner, site: ts.Node): StorageOrigin | undefined {
  const binding = state.model.resolve(identifier);
  const fact = binding ? storageFactForBinding(state, state.summaries, binding, owner, site) : undefined;
  return fact?.outer.length === 1 ? fact.outer[0] : undefined;
}

function outermostAccess(site: ts.Identifier): ts.Expression {
  let access: ts.Expression = outerExpression(site);
  while ((ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) && access.parent.expression === access) {
    access = outerExpression(access.parent);
  }
  return access;
}

function truncatedSlot(access: ts.Expression): string | undefined {
  const assignment = access.parent;
  const assigned = ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.left === access ? unwrapExpression(assignment.right) : undefined;
  return assigned && ts.isNumericLiteral(assigned) ? `append:${Number(assigned.text)}` : undefined;
}

function shareAliasedLocalBindings(
  state: AnalysisState,
  origins: readonly StorageOrigin[],
  site: ts.Node,
  owner: EffectOwner,
  slots = mutatedSlots(state, site, owner),
): void {
  const localOrigins = origins.filter((origin) => origin.startsWith("private:") || origin.startsWith("param:"));
  if (localOrigins.length === 0) {
    return;
  }
  for (const binding of state.model.bindings) {
    if (!isLocalBindingOfOwner(binding, owner)) {
      continue;
    }
    const fact = storageFactForBinding(state, state.summaries, binding, owner, site);
    for (const origin of localOrigins) {
      if ([...fact.outer, ...fact.reachable].includes(origin)) {
        const writes = state.sharedLocalBindings.get(binding) ?? new Map();
        for (const slot of slots) {
          writes.set(`${site.getStart()}/${origin}/${slot ?? "*"}`, { fact, origin, site, slot });
        }
        state.sharedLocalBindings.set(binding, writes);
      }
    }
  }
}

function isLocalBindingOfOwner(binding: Binding, owner: EffectOwner): boolean {
  return binding.declarations.some((declaration) =>
    (declaration.kind === "variable" || declaration.kind === "parameter") && inside(declaration.node, owner));
}

function mutatedSlots(state: AnalysisState, site: ts.Node, owner: EffectOwner): readonly (string | undefined)[] {
  if (ts.isIdentifier(site)) {
    const write = writeOf(state, site);
    if (write && !write.contents && !write.viaCall && !write.reassign) {
      return assignedSlots(state, site);
    }
  }
  return pushedArraySlots(state, site, owner) ?? [undefined];
}

function pushedArraySlots(state: AnalysisState, site: ts.Node, owner: EffectOwner): readonly string[] | undefined {
  const call = pushCallForMutation(site);
  if (!call) {
    return undefined;
  }
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return undefined;
  }
  const start = knownPushStart(state, callee.expression, owner, call);
  return start ? pushSlots(call, owner, start) : undefined;
}

function pushSlots(call: ts.CallExpression, owner: EffectOwner, start: PushStart): readonly string[] {
  if (call.arguments.length === 0) {
    return [];
  }
  const spread = call.arguments.some(ts.isSpreadElement);
  return ["property:length", ...(spread || repeatedCall(call, owner) || !start.exact ? [`append:${start.lowerBound}`]
    : Array.from(call.arguments.keys(), (index) => `property:${start.lowerBound + index}`))];
}

type TransferSource = { readonly node: ts.Node; readonly writeNode?: ts.Node; readonly repeated?: boolean };

/**
 * Gives the slots a callee's push changes in the caller's array, or undefined for every slot.
 * Exact slots need an exact caller start, a single direct push sequence in the callee, and a call that runs once.
 * Otherwise a push lands at or after the caller's start, unless the call can also shrink the array.
 */
function transferredPushSlots(
  state: AnalysisState, root: StorageFact, source: TransferSource, sourceOwner: EffectOwner,
  site: ts.Node, owner: EffectOwner, path: StoragePath = "outer",
): readonly string[] | undefined {
  const push = pushCallForMutation(source.writeNode ?? source.node);
  if (!push || path === "reachable") {
    return undefined;
  }
  const fact = path === "outer" ? root : path.reduce((value, slot) => memberStorageFact(value, slot), root);
  return isGenerator(sourceOwner) ? generatorPushSlots(state, fact, source, push, sourceOwner, site, owner)
    : invokedPushSlots(state, fact, source, push, sourceOwner, invocationAt(site), owner);
}

function invokedPushSlots(
  state: AnalysisState, fact: StorageFact, source: TransferSource, push: ts.CallExpression,
  sourceOwner: EffectOwner, invocation: Invocation | undefined, owner: EffectOwner,
): readonly string[] | undefined {
  const callerStart = invocation && knownPushStartFromFact(state, fact, owner, invocation);
  const offset = transferOffset(state, source, push, sourceOwner);
  if (!invocation || !callerStart || !offset || invocationResets(state, fact, invocation)) {
    return undefined;
  }
  return pushSlots(push, sourceOwner, { lowerBound: callerStart.lowerBound + offset.lowerBound,
    exact: callerStart.exact && offset.exact && !repeatedCall(invocation, owner) });
}

type Invocation = ts.CallExpression | ts.NewExpression;

function invocationAt(site: ts.Node): Invocation | undefined {
  return isInvocation(site) ? site : isInvocation(site.parent) && site.parent.expression === site ? site.parent : undefined;
}

function isInvocation(node: ts.Node): node is Invocation {
  return ts.isCallExpression(node) || ts.isNewExpression(node);
}

function pointArguments(point: ts.Node): readonly ts.Expression[] {
  return isInvocation(point) ? point.arguments ?? [] : [];
}

function generatorPushSlots(
  state: AnalysisState, fact: StorageFact, source: TransferSource, push: ts.CallExpression,
  sourceOwner: EffectOwner, site: ts.Node, owner: EffectOwner,
): readonly string[] | undefined {
  const point = forcingPoint(state, site);
  const origin = fact.outer.length === 1 ? fact.outer[0] : undefined;
  const length = origin === undefined ? undefined : literalAllocationLength(state, origin);
  const offset = transferOffset(state, source, push, sourceOwner);
  const bounds = point && origin && length !== undefined ? priorPushBounds(state, owner, point, origin, length) : undefined;
  if (!bounds || !offset) {
    return undefined;
  }
  return pushSlots(push, sourceOwner, { lowerBound: bounds.floor + offset.lowerBound, exact: false });
}

function forcingPoint(state: AnalysisState, site: ts.Node): ts.Node | undefined {
  if (iterates(site) || (ts.isCallExpression(site) && iteratorStep(site))) {
    return site;
  }
  return ts.isCallExpression(site.parent) && site.parent.expression === site && iteratedArgument(site.parent, state.model) !== undefined
    ? site.parent : undefined;
}

function iterates(node: ts.Node): boolean {
  return ts.isForOfStatement(node) || ts.isSpreadElement(node) || ts.isYieldExpression(node) || ts.isVariableDeclaration(node);
}

function iteratorStep(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    ["next", "return", "throw"].includes(methodName(callee) ?? "");
}

function transferOffset(state: AnalysisState, source: TransferSource, push: ts.CallExpression, sourceOwner: EffectOwner): PushStart | undefined {
  return source.writeNode || source.repeated ? { lowerBound: 0, exact: false } : calleePushOffset(state, push, sourceOwner);
}

function invocationResets(state: AnalysisState, fact: StorageFact, invocation: Invocation): boolean {
  return sharedWrites(state).some((write) => write.slot === undefined && fact.outer.includes(write.origin) &&
    (write.site === invocation || write.site === invocation.expression));
}

function sharedWrites(state: AnalysisState): SharedWrite[] {
  return [...state.sharedLocalBindings.values()].flatMap((writes) => [...writes.values()]);
}

function calleePushOffset(state: AnalysisState, push: ts.CallExpression, sourceOwner: EffectOwner): PushStart | undefined {
  const summary = state.summaries.get(sourceOwner);
  const target = pushReceiverKey(state, push);
  if (!summary || !target) {
    return undefined;
  }
  let offset: PushStart | undefined = { lowerBound: 0, exact: true };
  const counted = new Set<ts.CallExpression>([push]);
  for (const effect of [...summary.flows.filter(isWritingFlow), ...summary.parameterWrites]) {
    if (offset && mayRunBefore(writeEnd(effect), push, sourceOwner)) {
      offset = advanceCalleeOffset(state, offset, effect, target, counted, sourceOwner);
    }
  }
  return offset;
}

function writeEnd(effect: ImplicitFlow | ParameterWrite): ts.Node {
  const direct = "writeNode" in effect && effect.writeNode ? undefined : pushCallForMutation(effect.node);
  return direct ?? effect.node;
}

function advanceCalleeOffset(
  state: AnalysisState, offset: PushStart, effect: ImplicitFlow | ParameterWrite, target: string,
  counted: Set<ts.CallExpression>, sourceOwner: EffectOwner,
): PushStart | undefined {
  const forwarded = "writeNode" in effect ? effect.writeNode : undefined;
  const prior = pushCallForMutation(forwarded ?? effect.node);
  if (!prior || counted.has(prior)) {
    return prior ? offset : undefined;
  }
  counted.add(prior);
  const same = !forwarded && pushReceiverKey(state, prior) === target;
  return same ? advanceDirectPush(offset, prior, sourceOwner) : { ...offset, exact: false };
}

function isWritingFlow(flow: ImplicitFlow): boolean {
  return flow.kind !== "input" && flow.access !== "read" && flow.receiver !== "read";
}

function pushReceiverKey(state: AnalysisState, push: ts.CallExpression): string | undefined {
  const callee = unwrapExpression(push.expression);
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? storageKey(state, callee.expression) : undefined;
}

function storageKey(state: AnalysisState, expression: ts.Expression): string | undefined {
  let receiver = unwrapExpression(expression);
  const slots: string[] = [];
  while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
    const slot = storageSlot(receiver);
    if (slot === undefined) {
      return undefined;
    }
    slots.unshift(slot);
    receiver = unwrapExpression(receiver.expression);
  }
  const binding = ts.isIdentifier(receiver) ? state.model.resolve(receiver) : undefined;
  return binding ? JSON.stringify([binding.declarations[0].identifier.getStart(), ...slots]) : undefined;
}

function mayRunBefore(node: ts.Node, call: ts.Node, owner: EffectOwner): boolean {
  if (pointArguments(call).some((argument) => inside(node, argument))) {
    return true;
  }
  if (inside(node, call)) {
    return false;
  }
  return node.end <= call.getStart() || sharesLoop(node, call, owner);
}

function sharesLoop(node: ts.Node, call: ts.Node, owner: EffectOwner): boolean {
  for (let current: ts.Node | undefined = call.parent; current && current !== owner; current = current.parent) {
    if (ts.isIterationStatement(current, false) && repeatedPartOfIteration(call, current) && inside(node, current)) {
      return true;
    }
  }
  return false;
}

function repeatedCall(call: ts.Node, owner: EffectOwner): boolean {
  for (let current: ts.Node | undefined = call.parent; current && current !== owner; current = current.parent) {
    if (ts.isIterationStatement(current, false) && repeatedPartOfIteration(call, current)) {
      return true;
    }
  }
  return false;
}

function repeatedPartOfIteration(call: ts.Node, loop: ts.IterationStatement): boolean {
  if (inside(call, loop.statement)) {
    return true;
  }
  if (ts.isForStatement(loop)) {
    return !!((loop.condition && inside(call, loop.condition)) || (loop.incrementor && inside(call, loop.incrementor)));
  }
  return (ts.isWhileStatement(loop) || ts.isDoStatement(loop)) && inside(call, loop.expression);
}

function pushCallForMutation(site: ts.Node): ts.CallExpression | undefined {
  const member = ts.isIdentifier(site) ? unwrapExpression(outermostAccess(site)) : site;
  if ((!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member)) || methodName(member) !== "push") {
    return undefined;
  }
  const callee = outerExpression(member);
  const call = callee.parent;
  return ts.isCallExpression(call) && call.expression === callee ? call : undefined;
}

type PushStart = { readonly lowerBound: number; readonly exact: boolean };

function knownPushStart(state: AnalysisState, receiver: ts.Expression, owner: EffectOwner, call: ts.CallExpression): PushStart | undefined {
  const fact = storageFactForExpression(state, state.summaries, receiver, owner, call);
  return knownPushStartFromFact(state, fact, owner, call);
}

function knownPushStartFromFact(state: AnalysisState, fact: StorageFact, owner: EffectOwner, call: Invocation): PushStart | undefined {
  if (fact.outer.length !== 1) {
    return undefined;
  }
  const origin = fact.outer[0];
  const length = literalAllocationLength(state, origin);
  return length === undefined ? undefined : priorPushStart(state, owner, call, origin, length);
}

function literalAllocationLength(state: AnalysisState, origin: StorageOrigin): number | undefined {
  const position = /^private:(\d+)$/.exec(origin)?.[1];
  const allocation = position === undefined ? undefined : state.arrayLiterals.get(Number(position));
  return allocation && !allocation.elements.some(ts.isSpreadElement) ? allocation.elements.length : undefined;
}

function calleeOf(point: ts.Node): ts.Node | undefined {
  return isInvocation(point) ? point.expression : undefined;
}

type ArrayReference = { readonly reference: ts.Identifier; readonly fact: StorageFact };

function priorArrayReferences(state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin): ArrayReference[] {
  const references: { reference: ts.Identifier; fact: StorageFact }[] = [];
  for (const binding of state.model.bindings) {
    const bindingFact = storageFactForBinding(state, state.summaries, binding, owner, call);
    if (![...bindingFact.outer, ...bindingFact.reachable].includes(origin)) {
      continue;
    }
    for (const reference of binding.references) {
      if (referenceBefore(reference, call, owner)) {
        references.push({ reference, fact: bindingFact });
      }
    }
  }
  return references.sort((left, right) => left.reference.getStart() - right.reference.getStart());
}

function referenceBefore(reference: ts.Identifier, call: ts.Node, owner: EffectOwner): boolean {
  const callee = calleeOf(call);
  return !(callee && inside(reference, callee)) && inside(reference, owner) && !nestedFunctionBetween(reference, owner) &&
    (reference.getStart() < call.end || sharesLoop(reference, call, owner));
}

function nestedFunctionBetween(node: ts.Node, owner: EffectOwner): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== owner; current = current.parent) {
    if (isFunctionLike(current) || (isInstanceField(current) && current.parent !== owner)) {
      return true;
    }
  }
  return false;
}

function priorPushStart(
  state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin, initialLength: number,
): PushStart | undefined {
  return priorPushBounds(state, owner, call, origin, initialLength)?.start;
}

function priorPushBounds(
  state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin, initialLength: number,
): { readonly start: PushStart; readonly floor: number } | undefined {
  let start: PushStart = { lowerBound: initialLength, exact: true };
  let floor = initialLength;
  const counted = new Set<ts.CallExpression>();
  const references = priorArrayReferences(state, owner, call, origin);
  for (const item of references) {
    const next = advancePushStart(state, owner, call, origin, start, counted, item);
    if (!next) {
      return undefined;
    }
    start = next;
    floor = Math.min(floor, start.lowerBound);
  }
  const resolved = priorResolvedPushes(state, owner, call, origin, start);
  const shared = priorSharedWrites(state, owner, call, origin, resolved, new Set(references.map((item) => item.reference)));
  return shared && { start: shared, floor };
}

function priorSharedWrites(
  state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin, initial: PushStart,
  applied: ReadonlySet<ts.Node>,
): PushStart | undefined {
  let start = initial;
  for (const write of sharedWrites(state)) {
    if (write.origin !== origin || applied.has(write.site) || !inside(write.site, owner) || nestedFunctionBetween(write.site, owner) ||
        !mayRunBefore(write.site, call, owner)) {
      continue;
    }
    if (write.slot === undefined) {
      return undefined;
    }
    start = write.slot.startsWith("append:") ? { ...start, exact: false } : start;
  }
  return start;
}

function priorResolvedPushes(
  state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin, initial: PushStart,
): PushStart {
  let start = initial;
  const visit = (node: ts.Node): void => {
    if (node !== owner && (isFunctionLike(node) || (isInstanceField(node) && node.parent !== owner))) {
      return;
    }
    if (isInvocation(node) && node !== call && mayRunBefore(node, call, owner)) {
      start = advanceResolvedPushes(state, owner, origin, start, node);
    }
    const reachable = reachableChildren(node);
    if (reachable) {
      reachable.forEach(visit);
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(owner);
  return start;
}

function invocationTargets(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: Invocation): Targets {
  if (ts.isCallExpression(call)) {
    return resolveTargets(dispatchFor(state, summaries), call.expression);
  }
  const classes = classTargets(state.model, call.expression);
  return classes ? { targets: classes.map((created) => explicitConstructor(created) ?? created), complete: true } : { targets: [], complete: false };
}

function advanceResolvedPushes(
  state: AnalysisState, owner: EffectOwner, origin: StorageOrigin, initial: PushStart, call: Invocation,
): PushStart {
  const resolved = invocationTargets(state, state.summaries, call);
  const counted = new Set<ts.CallExpression>();
  const args = pointArguments(call);
  const invocation: StorageInvocation = { call, callable: call.expression,
    argumentFact: (index) => args[index]
      ? storageFactForExpression(state, state.summaries, args[index], owner, call) : unknownFact };
  let start = initial;
  for (const target of resolved.targets) {
    for (const insertion of state.summaries.get(target)?.storageInsertions ?? []) {
      const push = matchingResolvedPush(state, insertion, invocation, owner, origin, counted);
      if (!push) {
        continue;
      }
      counted.add(push);
      const once = resolved.complete && resolved.targets.length === 1 && insertion.node === push && runsOnEveryCall(push, target);
      start = advanceResolvedPush(start, push, call, owner, once);
    }
  }
  return start;
}

function matchingResolvedPush(
  state: AnalysisState, insertion: StorageInsertion, invocation: StorageInvocation,
  owner: EffectOwner, origin: StorageOrigin, counted: ReadonlySet<ts.CallExpression>,
): ts.CallExpression | undefined {
  const push = insertion.appendCall;
  return push && !counted.has(push) && push.arguments.length > 0 &&
    invocationStorageFact(state, state.summaries, insertion.target, invocation, owner).outer.includes(origin)
    ? push : undefined;
}

function advanceResolvedPush(
  start: PushStart, push: ts.CallExpression, call: Invocation, owner: EffectOwner, once: boolean,
): PushStart {
  return !once || !unconditional(call, owner) || repeatedCall(call, owner) || push.arguments.some(ts.isSpreadElement)
    ? { ...start, exact: false } : { ...start, lowerBound: start.lowerBound + push.arguments.length };
}

function runsOnEveryCall(push: ts.CallExpression, owner: EffectOwner): boolean {
  return unconditional(push, owner) && !repeatedCall(push, owner) && !exitsBefore(owner, push);
}

function exitsBefore(owner: EffectOwner, node: ts.Node): boolean {
  const visit = (current: ts.Node): boolean => {
    if (current !== owner && isFunctionLike(current)) {
      return false;
    }
    if ((ts.isReturnStatement(current) || ts.isThrowStatement(current)) && current.getStart() < node.getStart()) {
      return true;
    }
    return ts.forEachChild(current, visit) ?? false;
  };
  return visit(owner);
}

function advancePushStart(
  state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin,
  start: PushStart, counted: Set<ts.CallExpression>, { reference, fact }: ArrayReference,
): PushStart | undefined {
  const prior = receiverPushCall(reference);
  if (prior && prior.arguments.some((argument) => inside(call, argument))) {
    return start;
  }
  if (prior && priorPushOnArray(prior, reference, fact, origin, call, counted)) {
    counted.add(prior);
    return advanceDirectPush(start, prior, owner);
  }
  return prior === call ? start : priorArrayLengthWrite(state, fact, origin, start, reference, owner);
}

function advanceDirectPush(start: PushStart, prior: ts.CallExpression, owner: EffectOwner): PushStart {
  if (prior.arguments.length === 0) {
    return start;
  }
  return !unconditional(prior, owner) || repeatedCall(prior, owner) || prior.arguments.some(ts.isSpreadElement)
    ? { ...start, exact: false } : { ...start, lowerBound: start.lowerBound + prior.arguments.length };
}

function priorPushOnArray(
  prior: ts.CallExpression, reference: ts.Identifier, fact: StorageFact, origin: StorageOrigin,
  call: ts.Node, counted: ReadonlySet<ts.CallExpression>,
): boolean {
  const beforeCall = prior.end <= call.getStart() || pointArguments(call).some((argument) => inside(prior, argument)) ||
    (!isInvocation(call) && inside(prior, call));
  return beforeCall && !counted.has(prior) &&
    originsForPath(fact, selectedSlots(reference).slice(0, -1)).includes(origin);
}

function receiverPushCall(reference: ts.Identifier): ts.CallExpression | undefined {
  for (let current: ts.Node | undefined = reference.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
          methodName(callee) === "push" && inside(reference, callee.expression)) {
        return current;
      }
    }
    if (isFunctionLike(current) || ts.isSourceFile(current)) {
      return undefined;
    }
  }
  return undefined;
}

function priorArrayLengthWrite(
  state: AnalysisState,
  fact: StorageFact,
  origin: StorageOrigin,
  start: PushStart,
  reference: ts.Identifier,
  owner: EffectOwner,
): PushStart | undefined {
  const write = writeOf(state, reference);
  if (!write) {
    return start;
  }
  if (write.reassign) {
    return undefined;
  }
  const path = selectedSlots(reference);
  const prefix = [...path.keys(), path.length].find((depth) => originsForPath(fact, depth ? path.slice(0, depth) : "outer").includes(origin));
  return prefix === undefined ? start : arrayWriteAt(state, start, reference, path, prefix, owner);
}

function arrayWriteAt(
  state: AnalysisState, start: PushStart, reference: ts.Identifier, path: readonly string[], prefix: number, owner: EffectOwner,
): PushStart | undefined {
  const index = arrayIndexForSlot(path[prefix]);
  if (index !== undefined) {
    return index < start.lowerBound ? start : { ...start, exact: false };
  }
  if (appendIndexAt(state, reference, prefix)) {
    return { ...start, exact: false };
  }
  return prefix === path.length - 1 ? lengthChange(state, start, reference, path[prefix], owner) : undefined;
}

function lengthChange(state: AnalysisState, start: PushStart, reference: ts.Identifier, slot: string, owner: EffectOwner): PushStart | undefined {
  const access = outermostAccess(reference);
  const call = access.parent;
  const length = slot === "property:length" ? assignedLength(state, access, start, owner)
    : ts.isCallExpression(call) && call.expression === access && !repeatedCall(call, owner) ? calledLength(slot, call, start) : undefined;
  if (length === undefined) {
    return undefined;
  }
  return unconditional(access, owner) ? length : { lowerBound: Math.min(start.lowerBound, length.lowerBound), exact: false };
}

function assignedLength(state: AnalysisState, access: ts.Expression, start: PushStart, owner: EffectOwner): PushStart | undefined {
  const assignment = access.parent;
  const member = unwrapExpression(access);
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || assignment.left !== access ||
      !ts.isPropertyAccessExpression(member)) {
    return undefined;
  }
  const value = unwrapExpression(assignment.right);
  if (ts.isNumericLiteral(value)) {
    return { lowerBound: Number(value.text), exact: true };
  }
  return repeatedCall(assignment, owner) ? undefined : shortenedLength(state, value, member.expression, start);
}

function shortenedLength(state: AnalysisState, value: ts.Expression, array: ts.Expression, start: PushStart): PushStart | undefined {
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.MinusToken) {
    return undefined;
  }
  const length = unwrapExpression(value.left);
  const removed = literalCount(value.right);
  return removed !== undefined && ts.isPropertyAccessExpression(length) && length.name.text === "length" &&
    sameStorage(state, length.expression, array)
    ? { lowerBound: Math.max(start.lowerBound - removed, 0), exact: start.exact }
    : undefined;
}

const sameLengthMethods = new Set(["property:copyWithin", "property:fill", "property:reverse", "property:sort"]);

function calledLength(slot: string, call: ts.CallExpression, start: PushStart): PushStart | undefined {
  if (sameLengthMethods.has(slot)) {
    return start;
  }
  if (slot === "property:pop" || slot === "property:shift") {
    return { lowerBound: Math.max(start.lowerBound - 1, 0), exact: start.exact };
  }
  if (slot === "property:unshift") {
    return call.arguments.some(ts.isSpreadElement) ? undefined : { lowerBound: start.lowerBound + call.arguments.length, exact: start.exact };
  }
  return slot === "property:splice" ? splicedLength(call.arguments, start) : undefined;
}

function splicedLength(args: readonly ts.Expression[], start: PushStart): PushStart | undefined {
  const from = args[0] && literalCount(args[0]);
  const count = args[1] && literalCount(args[1]);
  if (args.length === 0) {
    return start;
  }
  if (from === undefined) {
    return undefined;
  }
  if (args.length === 1) {
    return { lowerBound: Math.min(start.lowerBound, from), exact: start.exact };
  }
  if (count === undefined || args.some(ts.isSpreadElement)) {
    return undefined;
  }
  const removed = Math.min(count, Math.max(start.lowerBound - from, 0));
  return { lowerBound: start.lowerBound - removed + args.length - 2, exact: start.exact };
}

function literalCount(expression: ts.Expression): number | undefined {
  const value = unwrapExpression(expression);
  return ts.isNumericLiteral(value) && Number.isInteger(Number(value.text)) ? Number(value.text) : undefined;
}

function appendIndexAt(state: AnalysisState, reference: ts.Identifier, depth: number): boolean {
  let access: ts.Expression = outerExpression(reference);
  for (let step = 0; step <= depth; step += 1) {
    access = access.parent as ts.Expression;
    if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) {
      return false;
    }
    access = step < depth ? outerExpression(access) : access;
  }
  return ts.isElementAccessExpression(access) && appendIndex(state, access);
}

function appendIndex(state: AnalysisState, access: ts.ElementAccessExpression): boolean {
  const key = unwrapExpression(access.argumentExpression);
  return ts.isPropertyAccessExpression(key) && key.name.text === "length" && sameStorage(state, key.expression, access.expression);
}

function sameStorage(state: AnalysisState, left: ts.Expression, right: ts.Expression): boolean {
  const key = storageKey(state, left);
  return key !== undefined && key === storageKey(state, right);
}

function sharedBindingCount(state: AnalysisState): number {
  return [...state.sharedBindings.values()].reduce((count, slots) => count + slots.size, 0) + [...state.sharedLocalBindings.values()].reduce((count, writes) => count + writes.size, 0);
}

function shareExposedReturns(state: AnalysisState, summary: CallableSummary): void {
  const owner = summary.owner;
  if (!isExposedOwner(state, owner)) {
    return;
  }
  const origins = summary.returnedAliases.flatMap((fact) => [...fact.outer, ...fact.reachable]);
  shareOrigins(state, origins.filter((origin) => {
    const binding = originBinding(state, origin)?.binding;
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
    const known = recognizedCallReturnFact(state, summaries, call, owner, seen);
    return known ? [known] : undefined;
  }
  return uniqueFacts(targets.flatMap((target) => {
    const summary = summaries.get(target);
    return summary ? summary.returnedAliases.map((fact) => instantiateReturnFact(state, summaries, fact, call, owner, target, seen)) : [];
  }));
}

function recognizedCallReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  seen: ReadonlySet<Binding> = new Set(),
): StorageFact | undefined {
  const known = libraryCall(call, state.model);
  if (!known || known.kind === "effect") {
    return undefined;
  }
  const target = libraryTarget(call, known);
  const receiver = target ? storageFactForExpression(state, summaries, target, owner, call, seen) : privateFact;
  return libraryReturnFact(state, summaries, call, owner, known, receiver, seen);
}

function libraryReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
  receiver: StorageFact,
  seen: ReadonlySet<Binding> = new Set(),
): StorageFact {
  switch (known.result) {
    case "fresh": return freshStorageFact(call);
    case "shallow": return shallowStorageFact(call, receiver);
    case "element": return libraryElementFact(call, receiver);
    case "receiver": return receiver;
    case "holding": return holdingReturnFact(state, summaries, call, owner, receiver, seen);
    case "mapped": return mappedReturnFact(state, summaries, call, owner, known, seen);
  }
}

function libraryElementFact(call: ts.CallExpression, receiver: StorageFact): StorageFact {
  const key = methodName(call.expression) === "get" && call.arguments[0] ? literalStorageKey(call.arguments[0]) : undefined;
  return memberStorageFact(receiver, key === undefined ? undefined : `entry:${key}`);
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
  seen: ReadonlySet<Binding>,
): StorageFact {
  const facts = call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call, seen));
  return allocatedFact(call, [receiver, ...facts].map((fact) => ({ slot: "*",
    fact: { ...fact, outer: [...fact.outer, ...fact.reachable] } })));
}

function mappedReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
  seen: ReadonlySet<Binding>,
): StorageFact {
  const callback = call.arguments[known.callbacks[0]];
  const targets = callback && callableTargets(state, summaries, callback);
  if (!targets) {
    return unknownFact;
  }
  const actualFacts = libraryCallbackFacts(state, summaries, call, owner, known);
  const returns = targets.flatMap((target) => (summaries.get(target)?.returnedAliases ?? []).map((fact) =>
    instantiateStorageFact(invokedStorageFact(fact, call), (index) => actualFacts[index] ?? unknownFact),
  ));
  const callee = unwrapExpression(call.expression);
  const name = methodName(callee);
  if (name === "reduce" || name === "reduceRight") {
    return joinStorageFacts([call.arguments[1] ? storageFactForExpression(state, summaries, call.arguments[1], owner, call, seen) : unknownFact, ...returns]);
  }
  return allocatedFact(call, returns.map((fact) => ({ slot: "*", fact })));
}

function instantiateReturnFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  fact: StorageFact,
  call: ts.CallExpression,
  owner: EffectOwner,
  callee: EffectOwner,
  seen: ReadonlySet<Binding> = new Set(),
): StorageFact {
  const cache = new Map<number, StorageFact>();
  const actualFact = (index: number): StorageFact => {
    const cached = cache.get(index);
    if (cached) {
      return cached;
    }
    const actual = call.arguments[index];
    const resolved = actual
      ? storageFactForExpression(state, summaries, actual, owner, call, seen)
      : defaultArgumentFact(state, summaries, callee, index, actualFact);
    cache.set(index, resolved);
    return resolved;
  };
  return instantiateStorageFact(invokedStorageFact(fact, call), actualFact);
}

function defaultArgumentFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  callee: EffectOwner,
  index: number,
  actualFact: (index: number) => StorageFact,
): StorageFact {
  const initializer = ownerParameters(callee)[index]?.initializer;
  return initializer
    ? instantiateStorageFact(storageFactForExpression(state, summaries, initializer, callee, initializer),
      (earlier) => earlier < index ? actualFact(earlier) : unknownFact)
    : unknownFact;
}

function instantiateStorageFact(
  fact: StorageFact,
  actualFact: (index: number) => StorageFact,
): StorageFact {
  const indexes = parameterOriginIndexes([...fact.outer, ...fact.reachable,
    ...(fact.cells ?? []).flatMap((cell) => [cell.allocation, ...cell.origins])]);
  return mapStorageFact(fact,
    (origins) => instantiateOrigins(origins, "outer", actualFact),
    (origins) => instantiateOrigins(origins, "reachable", actualFact),
    indexes.flatMap((index) => actualFact(index).cells ?? []));
}

function instantiateOrigins(
  origins: readonly StorageOrigin[],
  path: StoragePath,
  actualFact: (index: number) => StorageFact,
): readonly StorageOrigin[] {
  return joinStorageOrigins(origins.flatMap((origin) => {
    const projection = parameterProjection(origin);
    if (!projection) {
      return [origin];
    }
    const fact = projection.path.reduce((value, slot) => memberStorageFact(value, slot), actualFact(projection.parameterIndex));
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
  return facts.length <= 1 ? facts : [joinStorageFacts(facts)];
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
    const argumentFacts = call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call));
    escapeStorage(state, argumentFacts, call, owner);
    return { flows: [], writes: [], parameterCalls: [{ parameterIndex, node: call.expression, argumentFacts }] };
  }
  const known = libraryCall(call, state.model);
  if (known) {
    return libraryEffects(state, summaries, call, owner, known);
  }
  escapeStorage(state, callOperandFacts(state, summaries, call, owner), call, owner);
  return unknownEffects(call.expression, owner, "calls unresolved callable");
}

function callOperandFacts(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression | ts.NewExpression,
  owner: EffectOwner,
): StorageFact[] {
  const callee = unwrapExpression(call.expression);
  const operands = [
    ...(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? [callee.expression] : []),
    ...(call.arguments ?? []).map((argument) => ts.isSpreadElement(argument) ? argument.expression : argument),
  ];
  return operands.map((operand) => storageFactForExpression(state, summaries, operand, owner, call));
}

function escapeStorage(state: AnalysisState, facts: readonly StorageFact[], site: ts.Node, owner: EffectOwner): void {
  const origins = joinStorageOrigins(facts.flatMap((fact) => [...fact.outer, ...fact.reachable]));
  shareOrigins(state, origins);
  shareAliasedLocalBindings(state, origins, site, owner, [undefined]);
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
  const sites = (resolved.targets.every((target) => returnsIterator(summaries, target))
    ? generatorSites(state, call, owner) : undefined) ?? [call.expression];
  const receiver = callReceiver(state, summaries, call, owner);
  const captures = capturesForExpression(state, summaries, call.expression, owner, new Set());
  const groups = resolved.targets.flatMap((target) => {
    const summary = summaries.get(target);
    if (!summary) {
      return [unknownEffects(call.expression, owner, "calls unresolved callable")];
    }
    const instantiate = (part: CallableSummary, site: ts.Node) =>
      instantiateCallableSummary(state, summaries, part, call.arguments, site, owner, receiver, captures);
    if (isGenerator(target)) {
      return sites.map((site) => instantiate(summary, site));
    }
    const runs = summary.returnedRuns;
    return [instantiate(summary, call.expression), ...(runs ? sites.map((site) => instantiate(runSummary(summary, runs), site)) : [])];
  });
  if (!resolved.complete) {
    escapeStorage(state, callOperandFacts(state, summaries, call, owner), call, owner);
    groups.push(unknownEffects(call.expression, owner, "calls overridable method"));
  }
  return combineEffects(groups);
}

function callReceiver(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): StorageFact | undefined {
  const callee = unwrapExpression(call.expression);
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
    ? storageFactForExpression(state, summaries, callee.expression, owner, call) : undefined;
}

function returnsIterator(summaries: ReadonlyMap<EffectOwner, CallableSummary>, target: EffectOwner): boolean {
  return isGenerator(target) || summaries.get(target)?.returnedRuns !== undefined;
}

function runSummary(summary: CallableSummary, runs: CallEffects): CallableSummary {
  return {
    owner: summary.owner, flows: runs.flows, parameterWrites: runs.writes, parameterCalls: runs.parameterCalls,
    storageInsertions: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false,
  };
}

function iteratorRuns(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  expression: ts.Expression,
  owner: EffectOwner,
  seen: ReadonlySet<Binding>,
): CallEffects | undefined {
  const value = unwrapExpression(expression);
  const groups = ts.isCallExpression(value) ? callRuns(state, summaries, value, owner)
    : ts.isIdentifier(value) ? bindingRuns(state, summaries, value, owner, seen) : undefined;
  return groups && groups.length > 0 && groups.every((group) => group !== undefined)
    ? combineEffects(groups as CallEffects[]) : undefined;
}

function callRuns(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): (CallEffects | undefined)[] | undefined {
  const receiver = callReceiver(state, summaries, call, owner);
  return callableTargets(state, summaries, call.expression)?.map((target) => {
    const summary = summaries.get(target);
    const runs = summary?.returnedRuns;
    const part = summary && isGenerator(target) ? summary : summary && runs ? runSummary(summary, runs) : undefined;
    return part && instantiateCallableSummary(state, summaries, part, call.arguments, call, owner, receiver);
  });
}

function bindingRuns(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  reference: ts.Identifier,
  owner: EffectOwner,
  seen: ReadonlySet<Binding>,
): (CallEffects | undefined)[] | undefined {
  const binding = state.model.resolve(reference);
  if (!binding || seen.has(binding) || !inside(binding.scope.node, owner)) {
    return undefined;
  }
  const next = new Set(seen).add(binding);
  return bindingAssignments(binding).map((assignment) => assignment.value
    ? iteratorRuns(state, summaries, assignment.value, owner, next) : undefined);
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
  return joinCaptures(returned.map((closure) => new Map(state.model.bindings
    .filter((binding) => inside(binding.scope.node, factory) && !inside(binding.scope.node, closure) &&
      binding.references.some((reference) => inside(reference, closure)))
    .map((binding) => [binding, instantiateStorageFact(storageFactForBinding(state, summaries, binding, factory, closure), actualFact)]))));
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
  const global = globalName(call.expression, state.model);
  if (global === "JSON.parse") {
    return [privateFact, privateFact];
  }
  if (global === "JSON.stringify") {
    return [privateFact, call.arguments[0] ? storageFactForExpression(state, summaries, call.arguments[0], owner, call) : privateFact];
  }
  const target = libraryTarget(call, known);
  const receiver = target ? storageFactForExpression(state, summaries, target, owner, call) : privateFact;
  const name = methodName(unwrapExpression(call.expression));
  const initial = call.arguments[1] ? storageFactForExpression(state, summaries, call.arguments[1], owner, call) : undefined;
  return elementCallbackFacts(name, receiver, initial);
}

function elementCallbackFacts(name: string | undefined, receiver: StorageFact, initial: StorageFact | undefined): StorageFact[] {
  const element = elementFact(receiver);
  if (name === "reduce" || name === "reduceRight") {
    return [joinStorageFacts([initial ?? element, element]), element, privateFact, receiver];
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
  const effects = instantiateCallbackTargets(state, summaries, resolved.targets, facts, node, owner);
  if (resolved.complete) {
    return effects;
  }
  const index = parameterCallableIndex(state, callback, owner);
  if (index !== undefined) {
    effects.parameterCalls.push({ parameterIndex: index, node, argumentFacts: facts });
    return effects;
  }
  escapeStorage(state, facts, node, owner);
  return combineEffects([effects, unknownEffects(node, owner, "calls unresolved callable")]);
}

function instantiateCallableSummary(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  summary: CallableSummary,
  actuals: readonly ts.Expression[],
  node: ts.Node,
  owner: EffectOwner,
  receiver?: StorageFact,
  captures: ReadonlyMap<Binding, StorageFact> = new Map(),
): CallEffects {
  const active = <T extends { readonly defaultParameterIndex?: number }>(effects: readonly T[]) =>
    effects.filter((effect) => defaultMayRun(effect.defaultParameterIndex, actuals, state.model));
  const rebound = active(summary.flows).map((flow) => reboundFlow(state, summaries, flow, node, owner, receiver, captures));
  const flows = rebound.flatMap((effect) => effect.flows);
  const writes = rebound.flatMap((effect) => effect.writes);
  const parameterCalls: ParameterCall[] = [];
  const spread = actuals.findIndex(ts.isSpreadElement);
  const actualFact = (index: number): StorageFact => {
    if (spread >= 0 && index >= spread) {
      return unknownFact;
    }
    const actual = actuals[index];
    return actual
      ? storageFactForExpression(state, summaries, actual, owner, node)
      : defaultArgumentFact(state, summaries, summary.owner, index, actualFact);
  };
  const writeEffects = instantiateParameterWrites(state, active(summary.parameterWrites), actuals, actualFact, node, owner, summary.owner);
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
    summary.owner,
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
  return forwardedFlow(state, summaries, flow, node, owner);
}

function forwardedFlow(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  flow: ImplicitFlow,
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  const origins = flow.origins ?? [];
  if (!origins.some((origin) => ownedOrigin(state, origin, owner))) {
    return { flows: [movedFlow(flow, node, owner, flow.origins)], writes: [], parameterCalls: [] };
  }
  return combineEffects(origins.map((origin) => {
    const external = ownedOrigin(state, origin, owner);
    if (!external) {
      return { flows: [movedFlow(flow, node, owner, [origin])], writes: [], parameterCalls: [] };
    }
    const fact = storageFactForBinding(state, summaries, external.binding, owner, node);
    const subject = isParameterOf(external.binding, owner) ? "argument" : "caller-owned value";
    return mutationEffectsFromFact(state, fact, external.path.length ? external.path : "outer", node, owner, `mutates ${subject} ${external.binding.name}`);
  }));
}

function movedFlow(flow: ImplicitFlow, node: ts.Node, owner: EffectOwner, origins: readonly StorageOrigin[] | undefined): ImplicitFlow {
  return { ...flow, node, owner, defaultParameterIndex: undefined, writeNode: flow.writeNode ?? flow.node, origins };
}

function ownedOrigin(state: AnalysisState, origin: StorageOrigin, owner: EffectOwner): { binding: Binding; path: readonly string[] } | undefined {
  const external = originBinding(state, origin);
  return external && inside(external.binding.scope.node, owner) ? external : undefined;
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
  const slots = transferredPushSlots(state, fact, flow, flow.owner, node, owner, flow.path);
  return mutationEffectsFromFact(state, fact, flow.path ?? "outer", node, owner,
    isParameterOf(binding, owner) ? `mutates argument ${binding.name}` : `mutates caller-owned value ${binding.name}`,
    false, false, slots);
}

function capturedFlow(state: AnalysisState, flow: ImplicitFlow, fact: StorageFact, node: ts.Node, owner: EffectOwner): CallEffects {
  if (flow.access === "contents") {
    const slots = transferredPushSlots(state, fact, flow, flow.owner, node, owner, flow.path);
    return mutationEffectsFromFact(state, fact, flow.path ?? "outer", node, owner, flow.description, false, true, slots);
  }
  return flow.access === "read" ? receiverFlow(state, { ...flow, receiver: "read" }, fact, node, owner) : emptyCallEffects();
}

function receiverFlow(state: AnalysisState, flow: ImplicitFlow, receiver: StorageFact, node: ts.Node, owner: EffectOwner): CallEffects {
  if (flow.receiver === "write") {
    return mutationEffectsFromFact(state, receiver, flow.path ?? "outer", node, owner, "mutates receiver state", false, true);
  }
  const origins = originsForPath(receiver, flow.path ?? "outer");
  const effects = emptyCallEffects();
  if (externalReads(state, receiver, flow.reads ?? [{ path: [], reference: false }], owner, true)) {
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
  sourceOwner: EffectOwner,
): Pick<CallEffects, "flows" | "writes"> {
  return combineEffects(parameterWrites.map((write) => {
    const actual = actuals[write.parameterIndex] ?? ownerParameters(sourceOwner)[write.parameterIndex]?.initializer;
    if (!actual) {
      return unknownEffects(node, owner, "calls writable parameter without an argument");
    }
    const fact = actualFact(write.parameterIndex);
    const slots = transferredPushSlots(state, fact, write, sourceOwner, node, owner, write.path);
    return mutationEffectsFromFact(state, fact, write.path, node, owner,
      `mutates caller-owned value ${actual.getText(state.sourceFile)}`, false, true, slots);
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
  sourceOwner: EffectOwner,
): CallEffects {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const forwardedCalls: ParameterCall[] = [];
  for (const parameterCall of parameterCalls) {
    const callback = actuals[parameterCall.parameterIndex] ?? ownerParameters(sourceOwner)[parameterCall.parameterIndex]?.initializer;
    const argumentFacts = parameterCall.argumentFacts.map((fact) => instantiateStorageFact(fact, actualFact));
    if (!callback) {
      escapeStorage(state, argumentFacts, node, owner);
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
        escapeStorage(state, argumentFacts, node, owner);
        flows.push({ kind: "unknown", node, owner, description: "calls unresolved callable" });
      } else {
        forwardedCalls.push({ parameterIndex: callbackParameterIndex, node, argumentFacts });
      }
      continue;
    }
    const effects = instantiateCallbackTargets(state, summaries, callbackTargets, argumentFacts, node, owner);
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
): CallEffects {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const parameterCalls: ParameterCall[] = [];
  for (const target of targets) {
    const callbackSummary = summaries.get(target);
    if (!callbackSummary) {
      continue;
    }
    const effects = instantiateCallableSummaryFromFacts(state, summaries, callbackSummary, argumentFacts, node, owner);
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
): CallEffects {
  const rebound = summary.flows.map((flow) => reboundFlow(state, summaries, { ...flow, writeNode: flow.writeNode ?? flow.node }, node, owner));
  const actualFact = (index: number) => actualFacts[index] ?? unknownFact;
  const writes = summary.parameterWrites.map((write) => {
    const fact = actualFact(write.parameterIndex);
    const slots = transferredPushSlots(state, fact, { node: write.node, repeated: true }, summary.owner, node, owner, write.path);
    return mutationEffectsFromFact(state, fact, write.path, node, owner, "mutates caller-owned callback argument", false, true, slots);
  });
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
  if (!target || ts.isIdentifier(unwrapExpression(target)) || boundRoot(state, target) || rootIsThis(target)) {
    return emptyCallEffects();
  }
  const fact = storageFactForExpression(state, summaries, target, owner, call);
  const indexes = parameterOriginIndexes(fact.outer);
  const name = methodName(unwrapExpression(call.expression));
  return mutationEffectsFromFact(state, fact, "outer", call.expression, owner,
    indexes.length === 1 ? `mutates argument ${parameterName(owner, indexes[0])}` : `mutates receiver of ${name ?? "call"}`);
}

function computedWriteEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  target: ts.Expression,
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  const member = unwrapExpression(target);
  if ((!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member)) || namedRoot(member)) {
    return emptyCallEffects();
  }
  const fact = storageFactForExpression(state, summaries, member.expression, owner, node);
  const indexes = parameterOriginIndexes(fact.outer);
  return mutationEffectsFromFact(state, fact, "outer", member, owner,
    indexes.length === 1 ? `mutates argument ${parameterName(owner, indexes[0])}` : "mutates caller-owned value");
}

function namedRoot(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword;
}

function boundRoot(state: AnalysisState, expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) && state.model.resolve(current) !== undefined;
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
    if (isPureConstructor(globalName(expression, state.model))) {
      return emptyCallEffects();
    }
    escapeStorage(state, actuals.map((actual) =>
      storageFactForExpression(state, summaries, ts.isSpreadElement(actual) ? actual.expression : actual, owner, node)), node, owner);
    return unknownEffects(node, owner, "constructs unresolved class");
  }
  return combineEffects(classes.map((created) => {
    const summary = summaries.get(explicitConstructor(created) ?? created);
    return summary ? instantiateCallableSummary(state, summaries, summary, actuals, node, owner, privateFact)
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
    return summary ? [instantiateCallableSummary(state, summaries, summary, actuals, node, owner, receiver)] : [];
  });
  if (!resolved.complete) {
    groups.push(unknownEffects(node, owner, "accesses unresolved accessor"));
  }
  return combineEffects(groups);
}

function generatorSites(state: AnalysisState, call: ts.CallExpression, owner: EffectOwner): ts.Node[] | undefined {
  const direct = forcingSite(state.model, outerExpression(call));
  if (direct) {
    return [direct];
  }
  const holder = literalHolder(call);
  if (holder !== call) {
    return holderSites(state, holder, owner);
  }
  const parent = outerExpression(call).parent;
  if (isInertUse(state.model, outerExpression(call)) || isReturnedValue(call)) {
    return [];
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const binding = state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parent));
    return binding ? bindingForcingSites(state, binding, owner, new Set()) : undefined;
  }
  return undefined;
}

function literalHolder(expression: ts.Expression): ts.Expression {
  const value = outerExpression(expression);
  const parent = value.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === value) {
    return literalHolder(parent.parent);
  }
  return ts.isArrayLiteralExpression(parent) ? literalHolder(parent) : expression;
}

function holderSites(state: AnalysisState, holder: ts.Expression, owner: EffectOwner): ts.Node[] | undefined {
  const expression = outerExpression(holder);
  const parent = expression.parent;
  if (isReturnedValue(holder) || isInertUse(state.model, expression)) {
    return [];
  }
  const binding = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parent)) : undefined;
  return binding?.references.filter((reference) => inside(reference, owner)).flatMap((reference) =>
    referenceAssignment(reference) || isReturnedValue(reference) || isInertUse(state.model, outerExpression(reference))
      ? [] : [outerExpression(reference)]);
}

function isInertUse(model: ScopeModel, expression: ts.Expression): boolean {
  const parent = expression.parent;
  if (ts.isBinaryExpression(parent)) {
    return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
  }
  if (ts.isPrefixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (!ts.isCallExpression(parent) || parent.expression === expression) {
    return isDiscarded(parent);
  }
  const known = libraryCall(parent, model);
  return known?.kind === "pure" && known.result === "fresh" && known.callbacks.length === 0 && iteratedArgument(parent, model) === undefined;
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
    sites.push(...referenceForcingSites(state, reference, owner, next));
  }
  return sites;
}

function referenceForcingSites(state: AnalysisState, reference: ts.Identifier, owner: EffectOwner, seen: ReadonlySet<Binding>): ts.Node[] {
  const expression = outerExpression(reference);
  const site = forcingSite(state.model, expression);
  if (site) {
    return [site];
  }
  const parent = expression.parent;
  if (referenceAssignment(reference) || isInertUse(state.model, expression) || isReturnedValue(reference)) {
    return [];
  }
  const alias = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parent)) : undefined;
  return alias ? bindingForcingSites(state, alias, owner, seen) : [expression];
}

function isDiscarded(parent: ts.Node): boolean {
  return ts.isExpressionStatement(parent) || ts.isVoidExpression(parent) || ts.isTypeOfExpression(parent);
}

function isReturnedValue(node: ts.Expression): boolean {
  const value = outerExpression(node);
  const result = ts.isAwaitExpression(value.parent) ? outerExpression(value.parent) : value;
  return ts.isReturnStatement(result.parent) || (ts.isArrowFunction(result.parent) && result.parent.body === result);
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
  if (ts.isCallExpression(parent) && iteratedArgument(parent, model) === expression) {
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
    return targets !== undefined && targets.length > 0 && targets.every((target) => returnsIterator(summaries, target));
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
  storageInsertions: StorageInsertion[];
  returnedAliases: StorageFact[];
  returnedCallables: EffectOwner[];
  opaqueReturn: boolean;
  returnedRuns: (CallEffects | undefined)[];
};

function summarizeCallable(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  owner: EffectOwner,
  includeThis: boolean,
): CallableSummary {
  const draft: SummaryDraft = {
    flows: [], parameterWrites: [], parameterCalls: [], storageInsertions: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false,
    returnedRuns: [],
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
    draft.storageInsertions.push(...storageInsertionsForNode(state, summaries, node, owner));
  }
  executionRoots(owner).forEach(visit);
  appendEffects(draft, inheritedConstructorEffects(state, summaries, owner));
  return {
    owner,
    flows: uniqueSummaryFlows(draft.flows),
    parameterWrites: uniqueWrites(draft.parameterWrites),
    parameterCalls: uniqueParameterCalls(draft.parameterCalls),
    storageInsertions: uniqueInsertions(draft.storageInsertions),
    returnedAliases: uniqueFacts(draft.returnedAliases),
    returnedCallables: uniqueCallables(draft.returnedCallables),
    opaqueReturn: draft.opaqueReturn,
    returnedRuns: draft.returnedRuns.length > 0 && draft.returnedRuns.every((runs) => runs !== undefined)
      ? combineEffects(draft.returnedRuns as CallEffects[]) : undefined,
  };
}

function storageInsertionsForNode(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Node,
  owner: EffectOwner,
): StorageInsertion[] {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = unwrapExpression(node.left);
    if (ts.isIdentifier(target)) {
      const binding = state.model.resolve(target);
      return binding && !inside(binding.scope.node, owner) ? [{ kind: "binding", binding, node, origin: node,
        target: unknownFact, value: storageFactForExpression(state, summaries, node.right, owner, node), replace: unconditional(node, owner) }] : [];
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      return [{ kind: "cell", node, origin: node, target: storageFactForExpression(state, summaries, target.expression, owner, node),
        value: storageFactForExpression(state, summaries, node.right, owner, node),
        slot: storageSlot(target), replace: unconditional(node, owner) }];
    }
  }
  return isInvocation(node) ? callStorageInsertions(state, summaries, node, owner) : [];
}

function callStorageInsertions(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: Invocation,
  owner: EffectOwner,
): StorageInsertion[] {
  const resolved = invocationTargets(state, summaries, call);
  if (resolved.targets.length > 0) {
    return targetStorageInsertions(state, summaries, call, owner, resolved);
  }
  if (!ts.isCallExpression(call)) {
    return [];
  }
  const known = libraryCall(call, state.model);
  return known && known.kind !== "effect" ? [
    ...libraryStorageInsertions(state, summaries, call, owner, known),
    ...callbackStorageInsertions(state, summaries, call, owner, known),
  ] : [];
}

function targetStorageInsertions(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: Invocation,
  owner: EffectOwner,
  resolved: { readonly targets: readonly EffectOwner[]; readonly complete: boolean },
): StorageInsertion[] {
  const args = pointArguments(call);
  const invocation: StorageInvocation = { call, callable: call.expression,
    argumentFact: (index) => args[index] ? storageFactForExpression(state, summaries, args[index], owner, call) : unknownFact };
  const sites = (ts.isCallExpression(call) && resolved.targets.every(isGenerator) ? generatorSites(state, call, owner) : undefined) ?? [call];
  return sites.flatMap((node) => resolved.targets.flatMap((target) => {
    const summary = summaries.get(target);
    const direct = (summary?.storageInsertions ?? []).map((insertion) => instantiateInsertion(
      state, summaries, insertion, invocation, target, node, owner,
      resolved.targets.length === 1 && resolved.complete && unconditional(node, owner)));
    const callbacks = (summary?.parameterCalls ?? []).flatMap((parameterCall) => {
      const callback = args[parameterCall.parameterIndex];
      if (!callback) {
        return [];
      }
      const targets = resolveTargets(dispatchFor(state, summaries), callback);
      const facts = parameterCall.argumentFacts.map((fact) => invocationStorageFact(state, summaries, fact, invocation, owner));
      const callbackInvocation = { call, callable: callback, argumentFact: (index: number) => facts[index] ?? unknownFact };
      return targets.targets.filter((callbackTarget) => !isGenerator(callbackTarget)).flatMap((callbackTarget) =>
        (summaries.get(callbackTarget)?.storageInsertions ?? []).map((insertion) => instantiateInsertion(
          state, summaries, insertion, callbackInvocation, callbackTarget, node, owner,
          targets.complete && targets.targets.length === 1 && unconditional(parameterCall.node, target) && unconditional(node, owner), true)),
      );
    });
    return [...direct, ...callbacks];
  }));
}

function instantiateInsertion(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, insertion: StorageInsertion,
  invocation: StorageInvocation, sourceOwner: EffectOwner, node: ts.Node, owner: EffectOwner, mayReplace: boolean,
  repeated = false,
): StorageInsertion {
  const target = invocationStorageFact(state, summaries, insertion.target, invocation, owner);
  const slot = transferredInsertionSlot(state, insertion, target, invocation, sourceOwner, node, owner, repeated);
  return { ...insertion, node, target, value: invocationStorageFact(state, summaries, insertion.value, invocation, owner), slot,
    replace: mayReplace && (insertion.appendCall ? slot !== undefined && !slot.startsWith("append:") : insertion.replace) };
}

function transferredInsertionSlot(
  state: AnalysisState, insertion: StorageInsertion, target: StorageFact, invocation: StorageInvocation,
  sourceOwner: EffectOwner, node: ts.Node, owner: EffectOwner, repeated: boolean,
): string | undefined {
  const append = insertion.appendCall;
  if (!append) {
    return insertion.slot;
  }
  const push = append.expression;
  const source = { node: push, writeNode: insertion.node === append ? undefined : push, repeated };
  const slots = transferredPushSlots(state, target, source, sourceOwner, isGenerator(sourceOwner) ? node : invocation.call, owner);
  const argumentIndex = append.arguments.findIndex((argument) => argument === insertion.origin);
  return slots && argumentIndex >= 0 ? slots[argumentIndex + 1] : insertion.slot;
}

function callbackStorageInsertions(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
): StorageInsertion[] {
  return known.callbacks.flatMap((index) => {
    const callback = call.arguments[index];
    if (!callback) {
      return [];
    }
    const facts = libraryCallbackFacts(state, summaries, call, owner, known);
    const invocation: StorageInvocation = { call, callable: callback, argumentFact: (position) => facts[position] ?? unknownFact };
    const resolved = resolveTargets(dispatchFor(state, summaries), callback);
    return resolved.targets.filter((target) => !isGenerator(target)).flatMap((target) =>
      (summaries.get(target)?.storageInsertions ?? []).map((insertion) => instantiateInsertion(
        state, summaries, insertion, invocation, target, call, owner, false, true)),
    );
  });
}

function libraryStorageInsertions(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
  known: Exclude<LibraryCall, { kind: "effect" }>,
): StorageInsertion[] {
  const target = libraryTarget(call, known);
  if (!target) {
    return [];
  }
  const targetFact = storageFactForExpression(state, summaries, target, owner, call);
  const method = methodName(unwrapExpression(call.expression));
  const moved: StorageInsertion[] = movesElements(known, method)
    ? [{ kind: "cell", node: call, origin: target, target: targetFact, value: elementFact(targetFact), replace: false }]
    : [];
  if (known.stores === "none") {
    return moved;
  }
  const args = known.stores === "sources" ? call.arguments.slice(1)
    : known.stores === "splice" ? call.arguments.slice(2) : call.arguments;
  const parts = libraryStoredArguments(state, call, owner, known.stores, args);
  return [...moved, ...parts.map((part): StorageInsertion => {
    const value = storageFactForExpression(state, summaries, part.expression, owner, call);
    return { kind: "cell", node: call, origin: part.expression, target: targetFact,
      value: part.path === "reachable" ? elementFact(value) : value, slot: part.slot,
      appendCall: known.stores === "arguments" && method === "push" ? call : undefined,
      replace: part.slot !== undefined && !part.slot.startsWith("append:") && unconditional(call, owner) };
  })];
}

function libraryStoredArguments(
  state: AnalysisState, call: ts.CallExpression, owner: EffectOwner,
  stores: LibraryStorage, args: readonly ts.Expression[],
): StoredArgument[] {
  const parts = storedArguments(call, args, stores);
  const callee = unwrapExpression(call.expression);
  if (stores !== "arguments" || methodName(callee) !== "push" ||
      (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee))) {
    return parts;
  }
  const start = knownPushStart(state, callee.expression, owner, call);
  if (!start) {
    return parts;
  }
  const appendRange = !start.exact || repeatedCall(call, owner) || args.some(ts.isSpreadElement);
  return parts.map((part, index) => ({ ...part,
    slot: appendRange ? `append:${start.lowerBound}` : `property:${start.lowerBound + index}`,
  }));
}

type StoredArgument = { readonly expression: ts.Expression; readonly path: StoragePath; readonly slot?: string };

function storedArguments(call: ts.CallExpression, args: readonly ts.Expression[], stores: LibraryStorage): StoredArgument[] {
  if (stores === "entry") {
    const key = call.arguments[0] && literalStorageKey(call.arguments[0]);
    return call.arguments.slice(1).map((expression) => ({ expression, path: "outer", slot: key === undefined ? undefined : `entry:${key}` }));
  }
  return args.flatMap<StoredArgument>((expression) => stores === "sources" ? assignedProperties(expression) : [{ expression, path: "outer" }]);
}

function assignedProperties(expression: ts.Expression): StoredArgument[] {
  const value = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(value)) {
    return [{ expression, path: "reachable" }];
  }
  return value.properties.flatMap<StoredArgument>((property) => {
    if (ts.isSpreadAssignment(property)) {
      return [{ expression: property.expression, path: "reachable" }];
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return [{ expression: property.name, path: "outer", slot: `property:${property.name.text}` }];
    }
    const key = propertyStorageKey(property.name);
    return ts.isPropertyAssignment(property) ? [{ expression: property.initializer, path: "outer", slot: key === undefined ? undefined : `property:${key}` }] : [];
  });
}

function propertyStorageKey(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    return literalStorageKey(name.expression);
  }
  return ts.isPrivateIdentifier(name) ? undefined : name.text;
}

function literalStorageKey(expression: ts.Expression): string | undefined {
  const value = unwrapExpression(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : undefined;
}

function invocationStorageFact(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  fact: StorageFact,
  invocation: StorageInvocation,
  owner: EffectOwner,
): StorageFact {
  const substituted = instantiateStorageFact(invokedStorageFact(fact, invocation.call), invocation.argumentFact);
  const captures = capturesForExpression(state, summaries, invocation.callable, owner, new Set());
  const replace = (origins: readonly StorageOrigin[], select: (capture: StorageFact) => readonly StorageOrigin[]) => joinStorageOrigins(origins.flatMap((origin) => {
    const external = originBinding(state, origin);
    const binding = external?.binding;
    const capture = binding && (captures.get(binding) ?? (inside(binding.scope.node, owner)
      ? storageFactForBinding(state, summaries, binding, owner, invocation.call) : undefined));
    return capture && external
      ? select(external.path.reduce((value, slot) => memberStorageFact(value, slot), capture)) : [origin];
  }));
  const capturedCells = [...substituted.outer, ...substituted.reachable].flatMap((origin) => {
    const binding = originBinding(state, origin)?.binding;
    return binding && inside(binding.scope.node, owner)
      ? storageFactForBinding(state, summaries, binding, owner, invocation.call).cells ?? [] : [];
  });
  return mapStorageFact(substituted, (origins) => replace(origins, (capture) => capture.outer),
    (origins) => replace(origins, (capture) => capture.reachable), capturedCells);
}

function uniqueInsertions(insertions: readonly StorageInsertion[]): readonly StorageInsertion[] {
  const merged = new Map<string, StorageInsertion>();
  for (const insertion of insertions) {
    if (!keepsInsertion(insertion)) {
      continue;
    }
    const key = insertionMergeKey(insertion);
    const existing = merged.get(key);
    merged.set(key, existing
      ? { ...existing, target: joinStorageFacts([existing.target, insertion.target]), value: joinStorageFacts([existing.value, insertion.value]) }
      : insertion);
  }
  return [...merged.entries()].sort(compareInsertions).map(([, insertion]) => insertion);
}

function keepsInsertion(insertion: StorageInsertion): boolean {
  return insertion.kind !== "cell" || Boolean(insertion.appendCall) || insertion.target.outer.some(isCellAllocation);
}

function insertionMergeKey(insertion: StorageInsertion): string {
  const bindingId = insertion.kind === "binding" ? insertion.binding.declarations[0].identifier.getStart() : -1;
  const targetKey = insertion.replace ? JSON.stringify(insertion.target.outer) : "";
  return `${insertion.node.getStart()}:${insertion.origin.getStart()}:${insertion.kind}:${bindingId}:${insertion.slot ?? ""}:${insertion.appendCall?.getStart() ?? -1}:${insertion.replace}:${targetKey}`;
}

function compareInsertions([leftKey, left]: [string, StorageInsertion], [rightKey, right]: [string, StorageInsertion]): number {
  return left.node.end - right.node.end || left.origin.getStart() - right.origin.getStart() || leftKey.localeCompare(rightKey);
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
    ...writeTargets(node).map((target) => computedWriteEffects(state, summaries, target, node, owner)),
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
  const effects = instantiateCallbackTargets(state, summaries, resolved.targets, facts, node.tag, owner);
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
  draft.returnedRuns.push(iteratorRuns(state, summaries, expression, owner, new Set()));
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

function uniqueSummaryFlows(flows: readonly ImplicitFlow[]): readonly ImplicitFlow[] {
  const seen = new Set<string>();
  return flows.filter((flow) => {
    const site = flow.access === "contents" ? `${flow.node.getStart()}:${flow.writeNode?.getStart()}` : "";
    const key = `${ownerKey(flow.owner)}:${flow.kind}:${flow.description}:${site}`;
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
    insertions: summary.storageInsertions.map((insertion) => [insertion.node.getStart(), insertion.origin.getStart(), insertion.kind,
      insertion.target, insertion.value, insertion.slot, insertion.appendCall?.getStart(), insertion.replace]),
    aliases: summary.returnedAliases.map((fact) => [fact.outer, fact.reachable, fact.cells]).sort(),
    opaque: summary.opaqueReturn,
    returns: summary.returnedCallables.map((node) => node.pos).sort((left, right) => left - right),
    runs: summary.returnedRuns && [summary.returnedRuns.flows.map((flow) => [flow.kind, flow.description]),
      summary.returnedRuns.writes.map((write) => [write.parameterIndex, write.path]),
      summary.returnedRuns.parameterCalls.map((call) => call.parameterIndex)],
  });
}

function analyzeImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const model = analyzeScopes(sourceFile);
  const state = collectCallables(sourceFile, model, includeThis);
  const summaries = new Map<EffectOwner, CallableSummary>(state.callables.map((owner) => [
    owner,
    { owner, flows: [], parameterWrites: [], parameterCalls: [], storageInsertions: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false },
  ]));
  state.summaries = summaries;
  const keys = new Map<EffectOwner, string>();
  const bottomUp = [...state.callables].reverse();
  let converged = false;
  for (let index = 0; index < state.callables.length + 8; index += 1) {
    state.factCache.clear();
    state.insertionCache.clear();
    let changed = false;
    const sharedCount = sharedBindingCount(state);
    for (const owner of bottomUp) {
      const summary = summarizeCallable(state, summaries, owner, includeThis);
      shareExposedReturns(state, summary);
      const nextKey = summaryKey(summary);
      if (nextKey !== keys.get(owner)) {
        changed = true;
        keys.set(owner, nextKey);
        summaries.set(owner, summary);
        state.factCache.clear();
        state.insertionCache.clear();
      }
    }
    if (!changed && sharedCount === sharedBindingCount(state)) {
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
  return uniqueLines(uniqueFlows(withoutPassedReads(state.model, flows)));
}

function withoutPassedReads(model: ScopeModel, flows: readonly ImplicitFlow[]): ImplicitFlow[] {
  return flows.filter((flow) => {
    const call = flow.kind === "input" && ts.isIdentifier(flow.node) && !reassigned(model, flow.binding) ? argumentCall(flow.node) : undefined;
    return !call || !flows.some((other) => other.kind === "unknown" && other.owner === flow.owner &&
      (other.node === call || inside(other.node, call.expression)) && sameLine(other.node, flow.node));
  });
}

function argumentCall(node: ts.Identifier): ts.CallExpression | undefined {
  const expression = outerExpression(node);
  const call = expression.parent;
  return ts.isCallExpression(call) && call.arguments.some((argument) => argument === expression) ? call : undefined;
}

function reassigned(model: ScopeModel, binding: Binding | undefined): boolean {
  return !binding || binding.references.some((reference) => model.writeOf(reference)?.reassign);
}

function sameLine(left: ts.Node, right: ts.Node): boolean {
  const sourceFile = left.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(left.getStart()).line === sourceFile.getLineAndCharacterOfPosition(right.getStart()).line;
}

function uniqueLines(flows: readonly ImplicitFlow[]): ImplicitFlow[] {
  const seen = new Set<string>();
  return flows.filter((flow) => {
    const line = flow.node.getSourceFile().getLineAndCharacterOfPosition(flow.node.getStart()).line;
    const key = `${ownerKey(flow.owner)}:${flow.kind}:${line}`;
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
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
