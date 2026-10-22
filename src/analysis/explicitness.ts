// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { globalName } from "../ast/global-reference";
import { isFunctionLike, isFunctionLikeWithBody } from "../ast/functions";
import { keyName, methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { analyzeScopes, isAmbient, writeTargets } from "../ast/scopes";
import type { Binding, ScopeModel, Write } from "../ast/scopes";
import { reachableChildren } from "./control-flow";
import { ambientContents, bindingAssignments, canReachSite, inside, referenceAssignment, unconditional, isShortCircuit, type Assignment } from "./assignments";
import { callableTargets as resolveTargets, knownShapeHasMember, memberTargets, type Dispatch, type Targets } from "./dispatch";
import { classTargets, receiverShapes } from "./shapes";
import * as resolution from "./resolution";
import { ambientFlow, isLibraryMethodName, isPureConstructor, iteratedArgument, libraryCall, libraryCallbackNamed, hostReference, isHostRoot, movesElements, storesArguments, type LibraryCall, type LibraryCallback, type LibraryStorage } from "./library";
import { convertedValues, protocolExpressions } from "./protocol-sites";
import { supportsProtocol } from "./protocols";
import { standardReceiver } from "./standard-receivers";
import { readSites, receiverCall, selectedRead, storageSlot, writeAffectsRead, type ReadSite, type ReadMode } from "./reads";
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
  absorbsSlots,
  arrayIndexForSlot,
  elementFact,
  externalProjection,
  memberStorageFact,
  withInsertions,
  knownMemberFact,
  mapStorageFact,
  hasExternalOrigin,
  hostName,
  hasReceiverOrigin,
  hasUnknownOrigin,
  freshStorageFact,
  allocatedFact,
  allocationId,
  iteratedFact,
  pairsStorageFact,
  shallowStorageFact,
  selectedFact,
  invokedStorageFact,
  isCellAllocation,
  isWildcardSlot,
  joinStorageFacts,
  KEY_SLOT,
  visitedElementFact,
  joinStorageOrigins,
  originsForPath,
  parameterOriginIndexes,
  parameterProjection,
  type StorageCell,
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
  parameterIndex?: number;
  /** The write in a deeper callee that this flow forwards; set once a flow passes through a call it does not own. */
  writeNode?: ts.Node;
  /** The external storage an output flow mutates, so a caller that owns one of those bindings can re-resolve it. */
  origins?: readonly StorageOrigin[];
  argumentWrite?: "value" | "callback";
  readParameterIndex?: number;
  reads?: readonly ReadSite[];
};

type BindingAccess = "read" | "reassign" | "contents";

type ParameterWrite = {
  readonly parameterIndex: number;
  readonly path: StoragePath;
  readonly node: ts.Node;
  readonly description: string;
  readonly defaultParameterIndex?: number;
  readonly writeNode?: ts.Node;
};

type DeferredCallable =
  | { readonly kind: "parameter"; readonly parameterIndex: number }
  | { readonly kind: "capture"; readonly binding: Binding };

type DeferredCall = {
  readonly owner: EffectOwner;
  readonly argumentOwner: EffectOwner;
  readonly callee: DeferredCallable;
  readonly node: ts.Node;
  readonly argumentFacts: readonly StorageFact[];
  readonly defaultParameterIndex?: number;
};

type CallableSummary = {
  readonly owner: EffectOwner;
  readonly flows: readonly ImplicitFlow[];
  readonly parameterWrites: readonly ParameterWrite[];
  readonly deferredCalls: readonly DeferredCall[];
  readonly storageInsertions: readonly StorageInsertion[];
  readonly arrayResets: readonly StorageFact[];
  readonly returnedAliases: readonly StorageFact[];
  readonly yieldedAliases: readonly StorageFact[];
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
  readonly deferredCalls: DeferredCall[];
};

type SharedWrite = { readonly fact: StorageFact; readonly origin: StorageOrigin; readonly site: ts.Node; readonly slot?: string; readonly returned?: boolean };

type LexicalFrame = { readonly id: string; readonly context: readonly number[]; readonly owner: EffectOwner; readonly parent?: LexicalFrame };
type CallableInstance =
  | { readonly kind: "source"; readonly target: EffectOwner; readonly frame: LexicalFrame; readonly receiver?: StorageFact }
  | { readonly kind: "advance"; readonly iterator: StorageOrigin }
  | { readonly kind: "bound"; readonly callee: StorageFact; readonly receiver: StorageFact; readonly facts: readonly StorageFact[]; readonly actuals: readonly ts.Expression[] }
  | { readonly kind: "library"; readonly semantics: LibraryCallback }
  | { readonly kind: "iterator"; readonly source: Extract<CallableInstance, { kind: "source" }>; readonly facts: readonly StorageFact[]; readonly actuals: readonly ts.Expression[]; readonly receiver?: StorageFact };
type InvocationState = {
  readonly frame: LexicalFrame;
  readonly receiver?: StorageFact;
  readonly actuals?: readonly ts.Expression[];
  readonly phase?: "parameters" | "body";
  readonly caller?: { readonly owner: EffectOwner; readonly point: ts.Node; readonly callback: boolean; readonly repeated: boolean };
  store: Map<string, StorageFact>;
  heap: StorageInsertion[];
  readonly storageWrites: StorageInsertion[];
  readonly arrayResets: StorageFact[];
  arrays: Map<StorageOrigin, PushStart | undefined>;
  readonly registry: Map<StorageOrigin, CallableInstance>;
  readonly values: Map<ts.Expression, StorageFact>;
  readonly calls: Map<Invocation, { readonly effects: CallEffects; readonly value: StorageFact }>;
  readonly stack: readonly EffectOwner[];
  /** States left by break and continue, joined in where their target statement ends or repeats. */
  jumps?: Jump[];
  /** For each try block being walked, the states an exception could leave it in. */
  handlers?: FlowState[][];
};

type FlowState = { readonly store: Map<string, StorageFact>; readonly heap: StorageInsertion[]; readonly arrays: Map<StorageOrigin, PushStart | undefined> };
type Jump = FlowState & { readonly target: ts.Node; readonly kind: "break" | "continue" };

type AnalysisState = {
  readonly summarySubstitutions?: ReadonlySet<EffectOwner>;
  readonly invocation?: InvocationState;
  readonly callableRegistry: Map<StorageOrigin, CallableInstance>;
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
  /**
   * Paths in module bindings where a write may set a member a computed key names, such as Symbol.iterator. A path
   * ending in "**" covers every value beneath it, as when unknown code receives the storage.
   */
  readonly memberWrites: Map<Binding, Set<string>>;
  readonly bindingOrigins: ReadonlyMap<StorageOrigin, Binding>;
  readonly arrayLiterals: ReadonlyMap<number, ts.ArrayLiteralExpression>;
  readonly objectLiterals: ReadonlySet<number>;
  readonly exposedOwners: ReadonlySet<ts.Node>;
  readonly ownerReferences: Map<EffectOwner, readonly OwnerReferences[]>;
  readonly assignments: Map<Binding, Assignment[]>;
  readonly assignmentSites: AssignmentSites;
};

/** Indexes the bindings that each node assigns, built once per file, so recording an assignment does not scan every binding. */
type AssignmentSites = {
  declared?: Map<ts.Node, readonly (readonly [Binding, Assignment])[]>;
  iterated?: Map<ts.Node, readonly (readonly [Binding, Assignment])[]>;
  references?: readonly (readonly [ts.Identifier, number])[];
};

type OwnerReferences = { readonly binding: Binding; readonly references: readonly ts.Identifier[] };

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

function isAccessExpression(node: ts.Node): node is ts.AccessExpression {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
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
  return (isAccessExpression(parent)) && parent.expression === expression
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
  return binding.declarations.some((declaration) => declaration.kind === "import" && !!member || isAmbient(declaration.node) &&
    (ts.isVariableDeclaration(declaration.node) || (ts.isClassDeclaration(declaration.node) && !!member)));
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
  while (isAccessExpression(current)) {
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
  if (ts.isNewExpression(node)) {
    const read = heldRead(state, node, owner, owner, storageReadSites(state, node));
    return read ? [{ kind: "input", node, owner, description: `reads ${read.name}` }] : [];
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
  if (aliasOf(state.model, node)) {
    return [];
  }
  const flow = boundHostFlow(state, node, owner, write);
  return flow ? withCompoundRead(write, { kind: flow[0], node, owner, description: flow[1] }) : boundFlows(state, binding, node, owner, write);
}

function boundHostFlow(state: AnalysisState, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ReturnType<typeof ambientFlow> {
  if (write?.reassign) { return undefined; }
  const fact = storageFactForExpression(state, state.summaries, node, owner, node);
  const name = fact.outer.map(hostName).find((name) => name !== undefined);
  return name === undefined ? undefined : ambientFlow(node, write !== undefined, name || "globalThis");
}

function boundFlows(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ImplicitFlow[] {
  if (state.invocation && frameForBinding(state, binding)) {
    return invocationBindingFlows(state, binding, node, owner, write);
  }
  const shared = bindingSharesRead(state, binding, node, owner);
  const direct = bindingFlow(binding, node, owner, write, shared);
  if (direct) {
    return directBindingFlows(state, binding, node, owner, write, shared, direct);
  }
  const target = aliasTarget(state.model, binding, new Set());
  const aliased = target && bindingFlow(target, node, owner, write, shared || bindingSharesRead(state, target, node, owner));
  if (target && aliased) {
    return accessFlows(aliased, target, node, owner, write);
  }
  const read = localStorageRead(state, binding, node, owner, write, ambientContents(binding, owner, state.model) !== undefined);
  return read ? [{ kind: "input", node, owner, description: `reads ${read.name}` }] : [];
}

function directBindingFlows(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined, shared: boolean, direct: [ImplicitFlowKind, string]): ImplicitFlow[] {
  const held = localStorageRead(state, binding, node, owner, write);
  if (!held) {
    const readsContents = write && shared && writtenReadSites(state, node, write).some((site) => site.mode !== "reference");
    return accessFlows(direct, binding, node, owner, readsContents ? { ...write, compound: true } : write);
  }
  const read: ImplicitFlow = { kind: "input", node, owner, description: `reads ${held.name}` };
  return write ? [...accessFlows(direct, binding, node, owner, { ...write, compound: false }), read] : [read];
}

function invocationBindingFlows(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined): ImplicitFlow[] {
  const fact = storageFactForBinding(state, state.summaries, binding, owner, node);
  const sites = write ? writtenReadSites(state, node, write) : storageReadSites(state, node);
  const read = externalReads(state, fact, sites, owner, true) ?? (!write ? derivedRead(state, node, owner, owner) : undefined);
  if (!read) { return []; }
  const alias = ownsStorage(binding, owner) ? aliasTarget(state.model, binding, new Set()) : undefined;
  const description = alias && bindingFlow(alias, node, owner, undefined, true)?.[1];
  return [{ kind: "input", node, owner, binding: read, access: "read", readParameterIndex: parameterIndexOf(binding, owner),
    description: description ?? `reads ${read.name}` }];
}

/**
 * Gives the shared binding the read reaches. A module constant filled with a fresh array is read in the owner, where the
 * storage that array holds stays outside.
 */
function localStorageRead(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, write: Write | undefined, filled = false): Binding | undefined {
  const home = inside(binding.scope.node, owner) || filled ? owner : declaringOwner(state, binding);
  if (!home) {
    return undefined;
  }
  return heldRead(state, node, home, owner, write ? writtenReadSites(state, node, write) : storageReadSites(state, node));
}

/** Gives the shared binding that reading the storage of the expression, or of a result that holds it, reads. */
function heldRead(state: AnalysisState, node: ts.Expression, home: EffectOwner, owner: EffectOwner, sites: readonly ReadSite[]): Binding | undefined {
  return externalReads(state, storageFactForExpression(state, state.summaries, node, home, node), sites, owner, false) ??
    derivedRead(state, node, home, owner);
}

function writtenReadSites(state: AnalysisState, node: ts.Identifier, write: Write): ReadSite[] {
  if (write.compound) {
    return [{ path: selectedSlots(node), mode: "slots" }];
  }
  return receiverCall(outerExpression(node)) ? storageReadSites(state, node) : [];
}

function derivedRead(state: AnalysisState, node: ts.Expression, home: EffectOwner, owner: EffectOwner): Binding | undefined {
  const derived = derivedValue(state, selectedRead(node).expression);
  return derived && heldRead(state, derived, home, owner, storageReadSites(state, derived));
}

function derivedValue(state: AnalysisState, target: ts.Expression): ts.Expression | undefined {
  const parent = target.parent;
  if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent)) {
    return parent.parent;
  }
  const call = ts.isCallExpression(parent) ? parent : receiverCall(target);
  return call && !ts.isExpressionStatement(outerExpression(call).parent) && resultHolds(state, call, target) ? call : undefined;
}

function resultHolds(state: AnalysisState, call: ts.CallExpression, target: ts.Expression): boolean {
  const known = libraryCall(call, state.model);
  return !!known && known.kind !== "effect" && known.result !== "fresh" && libraryTarget(call, known) === target;
}

function declaringOwner(state: AnalysisState, binding: Binding): EffectOwner | undefined {
  return state.callables.filter((callable) => isLocalBindingOfOwner(binding, callable))
    .reduce<EffectOwner | undefined>((innermost, callable) => !innermost || inside(callable, innermost) ? callable : innermost, undefined);
}

function externalReads(
  state: AnalysisState, fact: StorageFact, sites: readonly ReadSite[], owner: EffectOwner, exported: boolean,
): Binding | undefined {
  for (const site of sites) {
    for (const { origin, rest } of selectedReadOrigins(fact, site)) {
      const external = originBinding(state, origin);
      if (external && ((exported && (isExportedStorage(external.binding) || isAmbientVariable(external.binding))) ||
          storageReadAffected(state, external.binding, projectedRead(external.path, rest, site.mode), owner))) {
        return external.binding;
      }
    }
  }
  return undefined;
}

function selectedReadOrigins(fact: StorageFact, site: ReadSite): { origin: StorageOrigin; rest: readonly string[] }[] {
  const selected = Array.from({ length: site.path.length + ((site.mode === "reference") ? 0 : 1) }, (_, length) =>
    originsForPath(fact, length ? site.path.slice(0, length) : "outer").map((origin) => ({ origin, rest: site.path.slice(length) })));
  const value = site.path.reduce((value, slot) => memberStorageFact(value, slot), fact);
  const held = site.mode === "deep" ? value.reachable
    : site.mode === "slots" ? memberStorageFact(value).outer.filter((origin) => {
      const external = externalProjection(origin);
      return !!external && external.path.length > 0;
    }) : [];
  return [...selected.flat(), ...held.map((origin) => ({ origin, rest: [] }))];
}

function projectedRead(path: readonly string[], rest: readonly string[], mode: ReadMode): ReadSite {
  return rest.length > 0 && absorbsSlots(path) ? { path, mode: "deep" } : { path: [...path, ...rest], mode };
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
  return readSites(node, (site, index) => ts.isCallExpression(site) ? callReadSites(state, site, index, seen) : argumentReadSites(state, site, index));
}

function callReadSites(state: AnalysisState, site: ts.CallExpression, index: number | "this", seen: Set<string>): ReadSite[] | undefined {
  if (index !== "this" && storesArguments(site, state.model)) {
    return [{ path: [], mode: "reference" }];
  }
  const known = libraryCall(site, state.model);
  const held = resultReadSites(state, site, index, known, seen);
  if (mutatesReceiver(known, index)) {
    return [{ path: [], mode: known && known.kind !== "effect" ? known.reads.receiver : "reference" }, ...held];
  }
  const sites = libraryReadSites(state, site, index, known, seen) ?? argumentReadSites(state, site, index);
  return held.length ? [...(sites ?? [{ path: [], mode: "slots" }]), ...held] : sites;
}

function mutatesReceiver(known: LibraryCall | undefined, index: number | "this"): boolean {
  return index === "this" && known?.kind === "mutating" && known.target === "receiver";
}

type LibraryEffect = Exclude<LibraryCall, { readonly kind: "effect" }>;

function resultReadSites(
  state: AnalysisState, call: ts.CallExpression, index: number | "this", known: LibraryCall | undefined, seen: Set<string>,
): ReadSite[] {
  return known && known.kind !== "effect" && resultHoldsTarget(call, index, known) ? targetReadsFromResult(state, call, known, seen) : [];
}

/** Tells if the call's result is kept and holds the argument at the index, the target of the library call. */
function resultHoldsTarget(call: ts.CallExpression, index: number | "this", known: LibraryEffect): boolean {
  return index === (known.target === "receiver" ? "this" : 0) && !ts.isExpressionStatement(outerExpression(call).parent);
}

function targetReadsFromResult(state: AnalysisState, call: ts.CallExpression, known: LibraryEffect, seen: Set<string>): ReadSite[] {
  if (known.result === "fresh" || known.result === "mapped" || known.result === "promise" || known.result === "promise-elements") {
    return [];
  }
  const sites = storageReadSites(state, call, seen);
  if (known.result === "receiver") {
    return sites;
  }
  if (known.result === "element") {
    return sites.map((site) => ({ path: ["*", ...site.path], mode: site.mode }));
  }
  const members = known.result === "pairs" ? 2 : 1;
  const aligned = membersAlign(call, known);
  return sites.flatMap((site) => {
    if (site.path.length === 0) {
      return (site.mode === "reference") ? [] : [site];
    }
    return [aligned ? { path: ["*", ...site.path.slice(members)], mode: site.mode } : { path: [], mode: "slots" }];
  });
}

/** Tells if each member of the result is a member, or a pair's member, of the receiver, as flat's are not. */
function membersAlign(call: ts.CallExpression, known: LibraryEffect): boolean {
  return (known.result === "shallow" || known.result === "pairs" || known.result === "holding") &&
    known.target === "receiver" && methodName(unwrapExpression(call.expression)) !== "flat";
}

function libraryReadSites(
  state: AnalysisState, site: ts.CallExpression, index: number | "this", known: LibraryCall | undefined, seen: Set<string>,
): ReadSite[] | undefined {
  if (index === 1 && known && known.kind !== "effect" && callbackRoles(methodName(unwrapExpression(site.expression)))[0] === "accumulator") {
    // reduce can return its initial value, so reads of the result read it.
    return [{ path: [], mode: "slots" }, ...storageReadSites(state, site, seen)];
  }
  if (known && known.kind !== "effect") {
    return [index === "this" ? receiverReadSite(site, known) : { path: [], mode: known.reads.arguments[index] ?? known.reads.rest }];
  }
  return undefined;
}

// A copy such as slice reads the receiver's slots but only holds its elements, as a spread does.
function receiverReadSite(site: ts.CallExpression, known: Exclude<LibraryCall, { kind: "effect" }>): ReadSite {
  const mode = known.reads.receiver;
  return mode === "slots" && known.callbacks.length === 0 && membersAlign(site, known) &&
    methodName(unwrapExpression(site.expression)) !== "toSorted" ? { path: ["*"], mode: "reference" } : { path: [], mode };
}

function argumentReadSites(
  state: AnalysisState, site: ts.CallExpression | ts.NewExpression | ts.AccessExpression, index: number | "this",
): ReadSite[] | undefined {
  if (!(ts.isCallExpression(site) || ts.isNewExpression(site)) || index === "this") {
    return [{ path: [], mode: "reference" }];
  }
  return calleeKnown(state, site) ? [{ path: [], mode: "reference" }] : undefined;
}

/** Tells if every function a call or construction may run is known. */
function calleeKnown(state: AnalysisState, site: ts.CallExpression | ts.NewExpression): boolean {
  const constructed = constructedClass(site);
  if (constructed) {
    const classes = classTargets(state.model, constructed);
    return classes.complete && classes.targets.length > 0;
  }
  if (invokesRegisteredInstances(state, site)) {
    return true;
  }
  const resolved = resolveTargets(dispatchFor(state, state.summaries), site.expression);
  return resolved.complete && resolved.targets.length > 0;
}

function invokesRegisteredInstances(state: AnalysisState, site: ts.CallExpression | ts.NewExpression): boolean {
  const active = state.invocation;
  if (!active) {
    return false;
  }
  const callee = storageFactForExpression(state, state.summaries, site.expression, active.frame.owner, site);
  return callee.outer.length > 0 && callee.outer.every((origin) => {
    const instance = invocationInstance(active, origin);
    return instance !== undefined && instance.kind !== "iterator";
  });
}

/** Gives the class a construction creates, the base class for a super call. */
function constructedClass(site: ts.CallExpression | ts.NewExpression): ts.Expression | undefined {
  if (ts.isNewExpression(site)) {
    return site.expression;
  }
  const enclosing = unwrapExpression(site.expression).kind === ts.SyntaxKind.SuperKeyword ? enclosingClass(site) : undefined;
  return enclosing && baseClassExpression(enclosing);
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
  return [...writes.values()].some(({ fact, origin, slot, returned }) =>
    (!returned || !invocationsRecorded(state, owner, binding)) &&
    Array.from({ length: site.path.length + 1 }, (_, length) => site.path.slice(0, length))
      .some((prefix) => originsForPath(fact, prefix.length ? prefix : "outer").includes(origin) && writeAffectsRead(site, prefix, slot)));
}

function selectedSlots(node: ts.Identifier): string[] {
  const slots: string[] = [];
  let current: ts.Expression = outerExpression(node);
  while ((isAccessExpression(current.parent)) &&
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
  while ((isAccessExpression(current.parent)) &&
      current.parent.expression === current) {
    slots.push(storageSlot(current.parent) ?? "*");
    current = outerExpression(current.parent);
  }
  return slots.length > 1 ? slots.slice(0, -1) : "outer";
}

function hostStorageFact(state: AnalysisState, value: ts.Expression, owner: EffectOwner): StorageFact | undefined {
  const name = hostReference(value, state.model);
  if (name === undefined) { return undefined; }
  const global: StorageFact = { outer: ["host:"], reachable: ["host:"] };
  if (name === "") { return global; }
  const heap = inside(value, owner) ? state.invocation?.heap ?? [] : [];
  return memberStorageFact(withInsertions(global, heap), `property:${name}`);
}

function returnStorageResolver(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
): StorageResolver {
  const useCache = summaries === state.summaries;
  const active = state.invocation;
  return {
    binding: (binding, owner, site) => invocationBinding(state, binding) ?? moduleCallableShape(state, binding, site),
    callable: active ? (method) => callableFact(active, method, active.frame) : undefined,
    value: (value, owner, site) => {
      const host = hostStorageFact(state, value, owner);
      if (host) { return host; }
      const resolved = owner === active?.frame.owner ? invocationValue(state, summaries, value) : undefined;
      if (resolved || !ts.isAwaitExpression(value)) { return resolved; }
      const pending = storageFactForExpression(state, summaries, value.expression, owner, site);
      if (pending.outer.some((origin) => origin.includes(":promise="))) {
        return memberStorageFact(pending, "promise:settled");
      }
      return pending.outer.length > 0 && pending.outer.every((origin) => active?.registry.get(origin)?.kind === "iterator")
        ? pending : undefined;
    },
    cache: useCache ? state.factCache : undefined,
    cycles: state.cycles,
    call: (call, owner, site, seen) =>
      ts.isCallExpression(call) ? joinedReturnFactForCall(state, summaries, call, owner, seen) : undefined,
    insertions: (owner, site) => {
      if (state.invocation && owner === state.invocation.frame.owner) {
        return state.invocation.heap;
      }
      const key = `${nodeKey(owner)}:${nodeKey(site)}`;
      const cached = useCache ? state.insertionCache.get(key) : undefined;
      if (cached) {
        return withInvocationHeap(state, cached);
      }
      const sourceOrigins = (origins: readonly StorageOrigin[]) => sourceAllocationOrigins(origins, owner);
      const computed = (summaries.get(owner)?.storageInsertions ?? [])
        .filter((insertion) => canReachSite(insertion.node, owner, site))
        .map((insertion) => ({ ...insertion,
          target: mapStorageFact(insertion.target, sourceOrigins, sourceOrigins),
          value: mapStorageFact(insertion.value, sourceOrigins, sourceOrigins),
          replace: insertion.replace && insertion.node.end <= site.getStart() && unconditional(insertion.node, owner) }));
      if (useCache) {
        state.insertionCache.set(key, computed);
      }
      return withInvocationHeap(state, computed);
    },
  };
}

function withInvocationHeap(state: AnalysisState, insertions: readonly StorageInsertion[]): readonly StorageInsertion[] {
  return state.invocation ? [...insertions, ...state.invocation.heap] : insertions;
}

function sourceAllocationOrigins(origins: readonly StorageOrigin[], owner: EffectOwner): readonly StorageOrigin[] {
  return origins.map((origin): StorageOrigin => origin.startsWith("private:") && origin.endsWith(`:frame=${ownerKey(owner)}`)
    ? `private:${Number(origin.split(":")[1])}` : origin);
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
  const fact = state.invocation?.values.get(node) ?? storageFactForBinding(state, summaries, binding, owner, node);
  if (!inside(binding.scope.node, owner)) {
    return capturedMutationEffects(state, binding, node, owner, path, fact);
  }
  return localMutationEffects(state, binding, node, owner, path, fact);
}

function capturedMutationEffects(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, path: StoragePath, fact: StorageFact): Pick<CallEffects, "flows" | "writes"> {
  shareCapturedWrite(state, binding, node, owner, path, fact);
  return state.invocation && frameForBinding(state, binding)
    ? mutationEffectsFromFact(state, fact, path, node, owner, `mutates caller-owned value ${binding.name}`, false, false, mutatedSlots(state, node, owner))
    : { flows: [], writes: [] };
}

function localMutationEffects(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, path: StoragePath, fact: StorageFact): CallEffects {
  const invocation = state.invocation;
  if (isParameterOf(binding, owner) && invocation?.caller) {
    return invokedParameterMutation(state, binding, node, owner, path, fact, invocation, invocation.caller);
  }
  const alias = aliasTarget(state.model, binding, new Set());
  return mutationEffectsFromFact(state, fact, path, node, owner, isParameterOf(binding, owner)
    ? `mutates argument ${node.text}`
    : alias && hasExternalOrigin(originsForPath(fact, path)) ? `writes ${node.text}` : `mutates caller-owned value ${node.text}`, false, false, mutatedSlots(state, node, owner));
}

function invokedParameterMutation(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner, path: StoragePath, fact: StorageFact, invocation: InvocationState, caller: NonNullable<InvocationState["caller"]>): CallEffects {
  const index = parameterIndexOf(binding, owner);
  const actual = index === undefined ? undefined : invocation.actuals?.[index] ?? ownerParameters(owner)[index]?.initializer;
  if (!actual && !caller.callback) {
    return unknownEffects(node, owner, "calls writable parameter without an argument");
  }
  return mutationEffectsFromFact(state, fact, path, node, owner, caller.callback
    ? "mutates caller-owned callback argument" : `mutates caller-owned value ${actual?.getText(state.sourceFile)}`, false, false, mutatedSlots(state, node, owner));
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
  const argumentWrite = argumentWriteForOrigins(state, origins, owner);
  return { flows: originFlows(state, origins, node, owner, description, receiverReported, slots)
    .map((flow) => argumentWrite ? { ...flow, argumentWrite } : flow), writes, deferredCalls: [] };
}

function argumentWriteForOrigins(state: AnalysisState, origins: readonly StorageOrigin[], owner: EffectOwner): ImplicitFlow["argumentWrite"] {
  const active = state.invocation;
  if (!active?.caller) { return undefined; }
  const argumentWrite = state.model.bindings.some((binding) => {
    if (!isParameterOf(binding, owner)) { return false; }
    const argument = active.store.get(cellKey(active.frame, binding));
    return argument && [...argument.outer, ...argument.reachable].some((origin) => origins.some((written) =>
      written === origin || externalProjection(written)?.base !== undefined && externalProjection(written)?.base === externalProjection(origin)?.base));
  });
  return argumentWrite ? active.caller.callback ? "callback" : "value" : undefined;
}

function originFlows(
  state: AnalysisState,
  origins: readonly StorageOrigin[],
  node: ts.Node,
  owner: EffectOwner,
  description: string,
  receiverReported = false,
  slots?: readonly (string | undefined)[],
): ImplicitFlow[] {
  const flows: ImplicitFlow[] = [];
  if (hasExternalOrigin(origins)) {
    shareOrigins(state, origins, slots?.map((slot) => slot ?? "*"), "exact");
    flows.push({ kind: "output", node, owner, description, origins: origins.filter((origin) => origin.startsWith("external:") || origin.startsWith("host:")) });
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
  const objectLiterals = new Set<number>();
  const collectArrays = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      arrayLiterals.set(allocationId(node), node);
    }
    if (ts.isObjectLiteralExpression(node)) { objectLiterals.add(allocationId(node)); }
    ts.forEachChild(node, collectArrays);
  };
  collectArrays(sourceFile);
  return {
    model, sourceFile, callables: collectOwners(sourceFile), summaries: new Map(), callableRegistry: new Map(),
    factCache: new Map(), insertionCache: new Map(), cycles: { count: 0 }, includeThis,
    sharedBindings: new Map(), sharedLocalBindings: new Map(), memberWrites: new Map(),
    bindingOrigins: new Map(model.bindings.map((binding) => [externalBindingOrigin(binding), binding])),
    arrayLiterals, objectLiterals, exposedOwners: exposedOwners(model), ownerReferences: new Map(), assignments: new Map(), assignmentSites: {},
  };
}

function exposedOwners(model: ScopeModel): Set<ts.Node> {
  const owners = new Set<ts.Node>();
  for (const declaration of model.bindings.filter(isExportedBinding).flatMap((binding) => binding.declarations)) {
    owners.add(declaration.node);
    if (ts.isVariableDeclaration(declaration.node) && declaration.node.initializer) {
      owners.add(unwrapExpression(declaration.node.initializer));
    }
  }
  return owners;
}

function shareOrigins(
  state: AnalysisState, origins: readonly StorageOrigin[], slots: readonly string[] = ["*"], member: "deep" | "exact" | false = "deep",
): boolean {
  let changed = false;
  for (const origin of origins) {
    const external = originBinding(state, origin);
    if (external) {
      if (member) {
        const paths = state.memberWrites.get(external.binding) ?? new Set<string>();
        state.memberWrites.set(external.binding, paths.add(JSON.stringify(member === "deep" ? [...external.path, "**"] : external.path)));
      }
      const marks = state.sharedBindings.get(external.binding) ?? new Set<string>();
      for (const slot of slots) {
        const mark = JSON.stringify([...external.path, slot]);
        changed ||= !marks.has(mark);
        marks.add(mark);
      }
      state.sharedBindings.set(external.binding, marks);
    }
  }
  return changed;
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
    shareOrigins(state, [origin], capturedWriteSlots(state, binding, node, owner, path, origin), writesComputedMember(state, node) && "exact");
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

/**
 * Tells if a write through a name may set a member a computed key names. Named members and number or string keys
 * cannot name Symbol.iterator, and a library call that fills a collection sets no member.
 */
function writesComputedMember(state: AnalysisState, node: ts.Identifier): boolean {
  const access = outermostAccess(node);
  const name = outerExpression(node);
  if (access === name) {
    const parent = name.parent;
    return !(ts.isBinaryExpression(parent) && parent.left === name) && !storesCollectionContents(state, name);
  }
  if (ts.isCallExpression(access.parent) && access.parent.expression === access) {
    return !storesCollectionContents(state, access);
  }
  return accessChainMaySetSymbol(state.model, name, access);
}

function accessChainMaySetSymbol(model: ScopeModel, name: ts.Expression, access: ts.Expression): boolean {
  let current = name;
  while (current !== access && isAccessExpression(current.parent)) {
    const member = current.parent;
    if (ts.isElementAccessExpression(member) && !nonSymbolKey(model, member.argumentExpression)) { return true; }
    current = outerExpression(member);
  }
  return false;
}

/** Tells if a key's value is a number or a string, so it names no symbol member. */
function nonSymbolKey(model: ScopeModel, key: ts.Expression, seen: ReadonlySet<Binding> = new Set()): boolean {
  const value = unwrapExpression(key);
  if (primitiveKey(value)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(value)) {
    return value.name.text === "length";
  }
  if (ts.isBinaryExpression(value)) {
    return nonSymbolBinaryKey(model, value, seen);
  }
  const binding = ts.isIdentifier(value) ? model.resolve(value) : undefined;
  return !!binding && !seen.has(binding) && nonSymbolBinding(model, binding, new Set(seen).add(binding));
}

function primitiveKey(value: ts.Expression): boolean {
  return ts.isNumericLiteral(value) || ts.isStringLiteralLike(value) || ts.isTemplateExpression(value) ||
    ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value);
}

function nonSymbolBinaryKey(model: ScopeModel, value: ts.BinaryExpression, seen: ReadonlySet<Binding>): boolean {
  const operator = value.operatorToken.kind;
  if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) { return nonSymbolKey(model, value.right, seen); }
  return !isShortCircuit(operator) || nonSymbolKey(model, value.left, seen) && nonSymbolKey(model, value.right, seen);
}

function nonSymbolBinding(model: ScopeModel, binding: Binding, next: ReadonlySet<Binding>): boolean {
  return binding.declarations.every((declaration) => ts.isParameter(declaration.node)
    ? declaration.node.type !== undefined && nonSymbolType(declaration.node.type)
    : ts.isVariableDeclaration(declaration.node) && (declaration.node.initializer !== undefined || ts.isForInStatement(declaration.node.parent.parent))) &&
    bindingAssignments(binding).every((assignment) => assignment.value !== undefined && !assignment.element && nonSymbolKey(model, assignment.value, next));
}

function nonSymbolType(type: ts.TypeNode): boolean {
  if (ts.isUnionTypeNode(type)) { return type.types.every(nonSymbolType); }
  return type.kind === ts.SyntaxKind.NumberKeyword || type.kind === ts.SyntaxKind.StringKeyword || ts.isLiteralTypeNode(type);
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
  const slot = isAccessExpression(member) ? storageSlot(member) : undefined;
  if (slot === "property:length") {
    return assignedLengthSlots(state, site, access, slot);
  }
  if (ts.isElementAccessExpression(member) && member.expression === outerExpression(site) && appendIndex(state, member)) {
    return appendSlots(state, site, member);
  }
  return arrayIndexForSlot(slot) === undefined ? [slot] : [slot, "property:length"];
}

/**
 * Gives the slots "list[list.length] = item" writes. A run of a helper knows the caller's array length, so a parameter
 * gets the same start a push through it would. A for-of target writes once per item, so it gets no single slot.
 */
function appendSlots(state: AnalysisState, site: ts.Identifier, member: ts.ElementAccessExpression): readonly (string | undefined)[] {
  if (literalArray(state, site)) {
    return [`append:${appendStart(state, site, member)}`, "property:length"];
  }
  const owner = !loopTarget(outerExpression(member)) && enclosingFunction(site);
  return [owner ? evaluatedSlot(state, state.summaries, member, owner, member) : undefined, "property:length"];
}

function assignedLengthSlots(state: AnalysisState, site: ts.Identifier, access: ts.Expression, slot: string): readonly (string | undefined)[] {
  const truncated = truncatedSlot(access);
  const binding = state.model.resolve(site);
  const maximum = binding && arrayLengthUpperBound(state, binding);
  return truncated !== undefined && maximum !== undefined && maximum <= Number(truncated.slice(7))
    ? [slot] : [slot, truncated];
}

function arrayLengthUpperBound(state: AnalysisState, binding: Binding): number | undefined {
  let maximum = literalArrayLength(binding);
  if (maximum === undefined || isModuleScope(binding)) { return undefined; }
  for (const reference of binding.references) {
    const assignment = arrayReferenceWrite(state, reference);
    if (assignment === undefined) { return undefined; }
    if (assignment === false) { continue; }
    const { slot, value } = assignment;
    if (slot === "property:length") {
      if (!ts.isNumericLiteral(value)) { return undefined; }
      maximum = Math.max(maximum, Number(value.text));
    } else {
      const index = arrayIndexForSlot(slot);
      if (index === undefined) { return undefined; }
      maximum = Math.max(maximum, index + 1);
    }
  }
  return maximum;
}

function arrayReferenceWrite(state: AnalysisState, reference: ts.Identifier): { readonly slot: string | undefined; readonly value: ts.Expression } | false | undefined {
  const expression = outerExpression(reference);
  const member = expression.parent;
  if ((!isAccessExpression(member)) || member.expression !== expression) { return undefined; }
  const access = outerExpression(member);
  if (ts.isCallExpression(access.parent)) { return undefined; }
  if (!writeOf(state, reference)) { return false; }
  const assignment = access.parent;
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || assignment.left !== access) { return undefined; }
  return { slot: storageSlot(member), value: unwrapExpression(assignment.right) };
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
  while ((isAccessExpression(access.parent)) && access.parent.expression === access) {
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
  returned = false,
): boolean {
  const localOrigins = origins.filter((origin) => origin.startsWith("private:") || origin.startsWith("param:"));
  if (localOrigins.length === 0) {
    return false;
  }
  let changed = false;
  const bindings = state.model.bindings.filter((binding) => isLocalBindingOfOwner(binding, owner) || frameForBinding(state, binding));
  for (const binding of bindings) {
    const fact = storageFactForBinding(state, state.summaries, binding, owner, site);
    for (const origin of localOrigins) {
      if ([...fact.outer, ...fact.reachable].includes(origin)) {
        const writes = state.sharedLocalBindings.get(binding) ?? new Map();
        for (const slot of slots) {
          const key = `${site.getStart()}/${origin}/${slot ?? "*"}/${returned}`;
          changed ||= !sameSharedWrite(writes.get(key), site, fact);
          writes.set(key, { fact, origin, site, slot, returned });
        }
        state.sharedLocalBindings.set(binding, writes);
      }
    }
  }
  return changed;
}

function sameSharedWrite(earlier: SharedWrite | undefined, site: ts.Node, fact: StorageFact): boolean {
  return !!earlier && earlier.site === site && (earlier.fact === fact || JSON.stringify(earlier.fact) === JSON.stringify(fact));
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
  if (!isAccessExpression(callee)) {
    return undefined;
  }
  const start = knownPushStart(state, callee.expression, owner, call);
  return start ? pushSlots(call, owner, state.invocation?.caller?.repeated ? { ...start, exact: false } : start) : undefined;
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
  return (isAccessExpression(callee)) &&
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
  return isAccessExpression(callee) ? storageKey(state, callee.expression) : undefined;
}

function storageKey(state: AnalysisState, expression: ts.Expression): string | undefined {
  let receiver = unwrapExpression(expression);
  const slots: string[] = [];
  while (isAccessExpression(receiver)) {
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
  if ((!isAccessExpression(member)) || methodName(member) !== "push") {
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
  const external = originBinding(state, origin);
  if (external) {
    const length = external.path.length === 0 ? literalArrayLength(external.binding) : undefined;
    return length === undefined ? undefined : { lowerBound: length, exact: false };
  }
  if (state.invocation?.arrays.has(origin)) { return state.invocation.arrays.get(origin); }
  const length = literalAllocationLength(state, origin);
  return length === undefined ? undefined : state.invocation
    ? { lowerBound: length, exact: true } : priorPushStart(state, owner, call, origin, length);
}

function literalAllocationLength(state: AnalysisState, origin: StorageOrigin): number | undefined {
  const match = /^private:(\d+)(?::(\d+))?(?:[:,]frame=.*)?$/.exec(origin);
  const allocation = match ? state.arrayLiterals.get(Number(match[1])) : undefined;
  if (!match || !allocation || allocation.elements.some(ts.isSpreadElement)) {
    return undefined;
  }
  // A direct return keeps the literal length. Another return path can change that length.
  const returned = outerExpression(allocation);
  const directReturn = ts.isReturnStatement(returned.parent) || ts.isArrowFunction(returned.parent);
  return match[2] === undefined || directReturn ? allocation.elements.length : undefined;
}

function calleeOf(point: ts.Node): ts.Node | undefined {
  return isInvocation(point) ? point.expression : undefined;
}

type ArrayReference = { readonly reference: ts.Identifier; readonly fact: StorageFact };

function priorArrayReferences(state: AnalysisState, owner: EffectOwner, call: ts.Node, origin: StorageOrigin): ArrayReference[] {
  const references: { reference: ts.Identifier; fact: StorageFact }[] = [];
  for (const { binding, references: owned } of referencesWithin(state, owner)) {
    const prior = owned.filter((reference) => referenceBefore(reference, call, owner));
    if (prior.length === 0) {
      continue;
    }
    const bindingFact = storageFactForBinding(state, state.summaries, binding, owner, call);
    if ([...bindingFact.outer, ...bindingFact.reachable].includes(origin)) {
      references.push(...prior.map((reference) => ({ reference, fact: bindingFact })));
    }
  }
  return references.sort((left, right) => left.reference.getStart() - right.reference.getStart());
}

function referencesWithin(state: AnalysisState, owner: EffectOwner): readonly OwnerReferences[] {
  let owned = state.ownerReferences.get(owner);
  if (!owned) {
    owned = state.model.bindings
      .map((binding) => ({ binding, references: binding.references.filter((reference) => inside(reference, owner)) }))
      .filter((item) => item.references.length > 0);
    state.ownerReferences.set(owner, owned);
  }
  return owned;
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
  return resolution.map(classes, created => explicitConstructor(created) ?? created);
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
      if ((isAccessExpression(callee)) &&
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
    if (!isAccessExpression(access)) {
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
  return [...state.sharedBindings.values()].reduce((count, slots) => count + slots.size, 0) + [...state.sharedLocalBindings.values()].reduce((count, writes) => count + writes.size, 0) +
    [...state.memberWrites.values()].reduce((count, paths) => count + paths.size, 0);
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
  return hasExportModifier(owner) || state.exposedOwners.has(owner);
}

function dispatchFor(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>): Dispatch {
  return {
    model: state.model, owners: state.callables, assignments: (binding) => cachedAssignments(state, binding),
    libraryMethod: (receiver, name) => isLibraryMethodName(name) && standardReceiver(state.model, receiver),
    returns: (call, seen) => {
      const targets = resolveTargets(dispatchFor(state, summaries), call.expression, seen);
      const facts = targets.targets.flatMap((target) => summaries.get(target)?.returnedAliases ?? []);
      const origins = facts.flatMap((fact) => fact.outer);
      const returned = origins.flatMap((origin) => {
        const instance = state.callableRegistry.get(origin);
        return instance?.kind === "source" ? [instance.target] : [];
      });
      const complete = targets.complete && origins.length > 0 && origins.every((origin) => state.callableRegistry.has(origin));
      return resolution.inherit(targets, complete ? resolution.complete(uniqueCallables(returned)) : resolution.unresolved(uniqueCallables(returned)));
    },
  };
}

function cachedAssignments(state: AnalysisState, binding: Binding): Assignment[] {
  let assigned = state.assignments.get(binding);
  if (!assigned) {
    assigned = bindingAssignments(binding);
    state.assignments.set(binding, assigned);
  }
  return assigned;
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
  const invoked = state.invocation?.calls.get(call);
  if (invoked) {
    return invoked.value;
  }
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
  const executed = state.invocation?.calls.get(call);
  if (executed) {
    return [executed.value];
  }
  const targets = callableTargets(state, summaries, call.expression);
  if (!targets) {
    const known = recognizedCallReturnFact(state, summaries, call, owner, seen);
    return known ? [known] : undefined;
  }
  return uniqueFacts(targets.flatMap((target) => {
    const summary = summaries.get(target);
    if (!summary) { return []; }
    const returned = summary.returnedAliases.map((fact) => instantiateReturnFact(state, summaries, fact, call, owner, target, seen));
    return isAsync(target) ? [promiseFact(call, joinStorageFacts(returned), ownerKey(owner))] : returned;
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
  const shaped = shapedLibraryReturn(call, known.result, receiver);
  if (shaped) { return shaped; }
  const context = state.invocation?.frame.id ?? ownerKey(owner);
  switch (known.result) {
    case "promise": return promiseFact(call, receiver, context);
    case "promise-elements": return promiseFact(call, shallowStorageFact(call, receiver), context);
    case "holding": return holdingReturnFact(state, summaries, call, owner, receiver, seen);
    case "mapped": return mappedReturnFact(state, summaries, call, owner, known, seen);
    default: return unknownFact;
  }
}

function shapedLibraryReturn(call: ts.CallExpression, result: Exclude<LibraryCall, { kind: "effect" }>["result"], receiver: StorageFact): StorageFact | undefined {
  switch (result) {
    case "fresh": return freshStorageFact(call);
    case "shallow": return shallowStorageFact(call, receiver);
    case "element": return libraryElementFact(call, receiver);
    case "receiver": return receiver;
    case "pairs": return pairsStorageFact(call, calleeName(call), receiver);
    default: return undefined;
  }
}

function libraryElementFact(call: ts.CallExpression, receiver: StorageFact): StorageFact {
  return memberStorageFact(receiver, entrySlot(call));
}

function entrySlot(call: ts.CallExpression): string | undefined {
  const key = methodName(call.expression) === "get" && call.arguments[0] ? literalStorageKey(call.arguments[0]) : undefined;
  return key === undefined ? undefined : `entry:${key}`;
}

function libraryTarget(call: ts.CallExpression, known: Exclude<LibraryCall, { kind: "effect" }>): ts.Expression | undefined {
  if (known.target === "argument") {
    return call.arguments[0];
  }
  const callee = unwrapExpression(call.expression);
  return isAccessExpression(callee) ? callee.expression : undefined;
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
  return allocatedFact(call, [receiver, ...facts].flatMap((fact) => [{ slot: "*",
    fact: { ...fact, outer: [...fact.outer, ...fact.reachable] } }, { slot: "*", fact: iteratedFact(fact, calleeName(call)) }]));
}

function calleeName(call: ts.CallExpression): ts.Node {
  const callee = unwrapExpression(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee;
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
  return invocationStorageFact(state, summaries, fact, { call, callable: call.expression, argumentFact: actualFact }, owner);
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

function parameterCallableIndex(state: AnalysisState, expression: ts.Expression, owner: EffectOwner): number | undefined {
  const callee = unwrapExpression(expression);
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const binding = state.model.resolve(callee);
  return binding ? parameterIndexOf(binding, owner) : undefined;
}

function deferredCallable(state: AnalysisState, expression: ts.Expression, owner: EffectOwner): DeferredCallable | undefined {
  const value = unwrapExpression(expression);
  const binding = ts.isIdentifier(value) ? state.model.resolve(value) : undefined;
  if (!binding) { return undefined; }
  const parameterIndex = parameterIndexOf(binding, owner);
  if (parameterIndex !== undefined) { return { kind: "parameter", parameterIndex }; }
  const home = declaringOwner(state, binding);
  return home && !ts.isSourceFile(home) && home !== owner && inside(owner, home)
    ? { kind: "capture", binding } : undefined;
}

function emptyCallEffects(): CallEffects {
  return { flows: [], writes: [], deferredCalls: [] };
}

function callEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression,
  owner: EffectOwner,
): CallEffects {
  const executed = state.invocation?.calls.get(call);
  if (executed) {
    return executed.effects;
  }
  const lifecycle = lifecycleCallEffects(state, summaries, call, owner);
  if (lifecycle) { return lifecycle; }
  const resolved = resolveTargets(dispatchFor(state, summaries), call.expression);
  if (resolved.targets.length > 0) {
    return resolvedCallEffects(state, summaries, resolved, call, owner);
  }
  const callee = deferredCallable(state, call.expression, owner);
  if (callee) {
    const argumentFacts = call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call));
    escapeStorage(state, argumentFacts, call, owner);
    return { flows: [], writes: [], deferredCalls: [{ owner, argumentOwner: invocationFactOwner(state, owner), callee, node: call.expression, argumentFacts }] };
  }
  const known = currentLibraryCall(state, summaries, call, owner);
  if (known) {
    return libraryEffects(state, summaries, call, owner, known);
  }
  escapeStorage(state, callOperandFacts(state, summaries, call, owner), call, owner);
  return unknownEffects(call.expression, owner, "calls unresolved callable");
}

function matchesHostName(fact: StorageFact, name: string | undefined): boolean {
  return fact.outer.length > 0 && fact.outer.every((origin) => hostName(origin) === name);
}

function currentLibraryCall(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, owner: EffectOwner): LibraryCall | undefined {
  const expression = unwrapExpression(call.expression);
  const receiver = isAccessExpression(expression)
    ? storageFactForExpression(state, summaries, expression.expression, owner, call) : undefined;
  const replaced = receiver?.outer.some((origin) => hostName(origin) !== undefined) &&
    heapWritesMember(state, receiver, methodName(expression));
  const name = globalName(call.expression, state.model);
  const currentFact = isHostRoot(name?.split(".")[0])
    ? storageFactForExpression(state, summaries, call.expression, owner, call) : undefined;
  const current = currentFact === undefined || matchesHostName(currentFact, name);
  return replaced || !current ? undefined : libraryCall(call, state.model);
}

function lifecycleCallEffects(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, owner: EffectOwner): CallEffects | undefined {
  const calleeValue = unwrapExpression(call.expression);
  if ((isAccessExpression(calleeValue)) &&
      ["next", "return", "throw"].includes(methodName(calleeValue) ?? "")) {
    const forced = forceIterator(state, summaries, calleeValue.expression, call, owner, "advance");
    if (forced) { return forced; }
  }
  if (unwrapExpression(call.expression).kind === ts.SyntaxKind.SuperKeyword) {
    return superEffects(state, summaries, call, owner);
  }
  const callee = unwrapExpression(call.expression);
  if (isIteratorAdvance(state, summaries, callee)) {
    return emptyCallEffects();
  }
  return undefined;
}

function callOperandFacts(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  call: ts.CallExpression | ts.NewExpression,
  owner: EffectOwner,
): StorageFact[] {
  const callee = unwrapExpression(call.expression);
  const operands = [
    ...(isAccessExpression(callee) ? [callee.expression] : []),
    ...(call.arguments ?? []).map((argument) => ts.isSpreadElement(argument) ? argument.expression : argument),
  ];
  return operands.map((operand) => storageFactForExpression(state, summaries, operand, owner, call));
}

function escapeStorage(state: AnalysisState, facts: readonly StorageFact[], site: ts.Node, owner: EffectOwner): void {
  const origins = joinStorageOrigins(facts.flatMap((fact) => [...fact.outer, ...fact.reachable]));
  const sharedOrigins = shareOrigins(state, origins);
  const sharedLocals = shareAliasedLocalBindings(state, origins, site, owner, [undefined]);
  const active = state.invocation;
  if (active) {
    const target: StorageFact = { outer: origins, reachable: origins, cells: facts.flatMap((fact) => fact.cells ?? []) };
    const insertion: StorageInsertion = { kind: "cell", node: site, origin: site, target, value: unknownFact, replace: false };
    const heapLength = active.heap.length;
    pushHeap(active.heap, [insertion]);
    active.storageWrites.push(insertion);
    active.arrayResets.push(target);
    const resetsArrays = origins.some((origin) => !active.arrays.has(origin) || active.arrays.get(origin) !== undefined);
    origins.forEach((origin) => active.arrays.set(origin, undefined));
    // A repeated escape that changes no state leaves every cached fact as it would be recomputed.
    if (sharedOrigins || sharedLocals || resetsArrays || active.heap.length !== heapLength) {
      state.factCache.clear();
    }
  }
}

/** Exposes returned allocations and captured members to closures that can outlive their owner. */
function escapeReturnedStorage(state: AnalysisState, facts: readonly StorageFact[], site: ts.Node, owner: EffectOwner): void {
  const origins: StorageOrigin[] = [];
  for (const origin of joinStorageOrigins(facts.flatMap((fact) => [...fact.outer, ...fact.reachable]))) {
    const external = originBinding(state, origin);
    if (!external) {
      if (origin.startsWith("private:")) { origins.push(origin); }
      continue;
    }
    if (isModuleScope(external.binding) || invocationsRecorded(state, owner, external.binding)) { continue; }
    if (external.path.length === 0) {
      origins.push(origin);
      continue;
    }
    shareReturnedMember(state, external, site);
  }
  shareOrigins(state, origins);
  shareAliasedLocalBindings(state, origins, site, owner, [undefined], true);
}

/** Resolves a returned member to the storage it holds and exposes that storage to closures beside the return. */
function shareReturnedMember(state: AnalysisState, external: { binding: Binding; path: readonly string[] }, site: ts.Node): void {
  const home = declaringOwner(state, external.binding);
  if (!home || ts.isSourceFile(home)) { return; }
  const fact = storageFactForBinding(state, state.summaries, external.binding, home, site);
  const selected = external.path.reduce((value, slot) => memberStorageFact(value, slot), fact);
  shareAliasedLocalBindings(state, [...selected.outer, ...selected.reachable], site, home, [undefined], true);
}

function isIteratorAdvance(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, callee: ts.Expression): boolean {
  return (isAccessExpression(callee)) &&
    ["next", "return", "throw"].includes(methodName(callee) ?? "") &&
    !heapWritesMember(state, storageFactForExpression(state, summaries, callee.expression, state.invocation?.frame.owner ?? state.sourceFile, callee), methodName(callee) ?? "") &&
    isKnownIterator(state, summaries, callee.expression);
}

function unknownEffects(node: ts.Node, owner: EffectOwner, description: string): CallEffects {
  return { flows: [{ kind: "unknown", node, owner, description }], writes: [], deferredCalls: [] };
}

function combineEffects(groups: readonly CallEffects[]): CallEffects {
  return {
    flows: groups.flatMap((group) => group.flows),
    writes: groups.flatMap((group) => group.writes),
    deferredCalls: groups.flatMap((group) => group.deferredCalls),
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
      const body = defaultEffects(summary, false);
      return [instantiate(runSummary(summary, defaultEffects(summary, true)), call.expression), ...sites.map((site) =>
        instantiate({ ...summary, flows: body.flows, parameterWrites: body.writes, deferredCalls: body.deferredCalls }, site))];
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
  return isAccessExpression(callee)
    ? storageFactForExpression(state, summaries, callee.expression, owner, call) : undefined;
}

function returnsIterator(summaries: ReadonlyMap<EffectOwner, CallableSummary>, target: EffectOwner): boolean {
  return isGenerator(target) || summaries.get(target)?.returnedRuns !== undefined;
}

function defaultEffects(summary: CallableSummary, defaults: boolean): CallEffects {
  const keep = <T extends { readonly defaultParameterIndex?: number }>(effects: readonly T[]) =>
    effects.filter((effect) => (effect.defaultParameterIndex !== undefined) === defaults);
  return { flows: keep(summary.flows), writes: keep(summary.parameterWrites), deferredCalls: keep(summary.deferredCalls) };
}

function runSummary(summary: CallableSummary, runs: CallEffects): CallableSummary {
  return {
    owner: summary.owner, flows: runs.flows, parameterWrites: runs.writes, deferredCalls: runs.deferredCalls,
    storageInsertions: [], arrayResets: [], returnedAliases: [], yieldedAliases: [],
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
    ? combineEffects(groups) : undefined;
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
  if (isAccessExpression(value)) {
    return capturesForExpression(state, summaries, value.expression, owner, seen);
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
  const closures = state.callables.filter((callable) => inside(callable, factory));
  return joinCaptures(closures.map((closure) => new Map(state.model.bindings
    .filter((binding) => inside(binding.scope.node, factory) && !inside(binding.scope.node, closure) &&
      binding.references.some((reference) => inside(reference, closure)))
    .map((binding) => [binding, instantiateStorageFact(storageFactForBinding(state, summaries, binding, factory, closure), actualFact)]))));
}

function receiverMutationEffects(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, owner: EffectOwner): CallEffects {
  const groups: CallEffects[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && methodCallOn(node) === call && writeOf(state, node)?.contents) {
      groups.push({ flows: directFlowsFor(state, node, owner, state.includeThis), writes: [], deferredCalls: [] });
      groups.push({ ...mutationEffectsFor(state, summaries, node, owner), deferredCalls: [] });
    }
    ts.forEachChild(node, visit);
  };
  visit(call.expression);
  return combineEffects(groups);
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
      const facts = libraryCallbackFacts(state, summaries, call, owner, known);
      groups.push(callbackEffects(state, summaries, callback, facts, call.expression, owner));
      const fact = storageFactForExpression(state, summaries, callback, owner, call);
      const active = state.invocation;
      const complete = fact.outer.length > 0 && fact.outer.every((origin) => {
        const instance = active?.registry.get(origin);
        return instance !== undefined && instance.kind !== "iterator";
      });
      if (!complete && !resolveTargets(dispatchFor(state, summaries), callback).complete) {
        const read = externalReads(state, joinStorageFacts(facts), [{ path: [], mode: "deep" }], owner, false);
        if (read) { groups.push({ flows: [{ kind: "input", node: call.expression, owner, binding: read, access: "read", description: `reads ${read.name}` }], writes: [], deferredCalls: [] }); }
      }
    }
  }
  if (known.kind === "mutating") {
    groups.push(receiverMutationEffects(state, summaries, call, owner));
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
    const root = call.arguments[0] ? storageFactForExpression(state, summaries, call.arguments[0], owner, call) : privateFact;
    return [privateFact, joinStorageFacts([root, unknownFact])];
  }
  const target = libraryTarget(call, known);
  const receiver = target ? storageFactForExpression(state, summaries, target, owner, call) : privateFact;
  const name = methodName(unwrapExpression(call.expression));
  const initial = call.arguments[1] ? storageFactForExpression(state, summaries, call.arguments[1], owner, call) : undefined;
  return elementCallbackFacts(name, receiver, initial);
}

type CallbackRole = "accumulator" | "element" | "index" | "receiver";

function callbackRoles(name: string | undefined): readonly CallbackRole[] {
  if (name === "reduce" || name === "reduceRight") {
    return ["accumulator", "element", "index", "receiver"];
  }
  if (name === "sort" || name === "toSorted") {
    return ["element", "element"];
  }
  return ["element", name === "forEach" ? "element" : "index", "receiver"];
}

function elementCallbackFacts(name: string | undefined, receiver: StorageFact, initial: StorageFact | undefined): StorageFact[] {
  const element = visitedElementFact(receiver);
  const facts = { accumulator: joinStorageFacts([initial ?? element, element]), element, index: privateFact, receiver };
  return callbackRoles(name).map((role) => facts[role]);
}

function callbackEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  callback: ts.Expression,
  facts: readonly StorageFact[],
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  const fact = storageFactForExpression(state, summaries, callback, owner, node);
  const evaluated = evaluateInvocation(state, summaries, {
    callee: fact,
    facts,
    point: node,
    owner,
    actuals: [],
    receiver: undefined,
    forceGenerator: false,
    execution: "callback",
  });
  if (evaluated) { return evaluated.effects; }
  const resolved = resolveTargets(dispatchFor(state, summaries), callback);
  const effects = instantiateCallbackTargets(state, summaries, resolved.targets, facts, node, owner);
  if (resolved.complete) {
    return effects;
  }
  const callee = deferredCallable(state, callback, owner);
  if (callee) {
    effects.deferredCalls.push({ owner, argumentOwner: invocationFactOwner(state, owner), callee, node, argumentFacts: facts });
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
  const deferredCalls: DeferredCall[] = [];
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
  const callbackEffects = instantiateDeferredCalls(
    state,
    summaries,
    active(summary.deferredCalls),
    actualFact,
    node,
    owner,
    summary.owner,
  );
  flows.push(...callbackEffects.flows);
  writes.push(...callbackEffects.writes);
  deferredCalls.push(...callbackEffects.deferredCalls);
  return { flows, writes, deferredCalls };
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
  if (flow.kind === "unknown" && resolvedReassignment(state, flow)) { return emptyCallEffects(); }
  const captured = flow.binding && captures.get(flow.binding);
  if (captured) {
    return capturedFlow(state, flow, captured, node, owner);
  }
  if (flow.binding && ownsStorage(flow.binding, owner)) {
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
    return { flows: [movedFlow(flow, node, owner, flow.origins)], writes: [], deferredCalls: [] };
  }
  return combineEffects(origins.map((origin) => {
    const external = ownedOrigin(state, origin, owner);
    if (!external) {
      return { flows: [movedFlow(flow, node, owner, [origin])], writes: [], deferredCalls: [] };
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
  return external && ownsStorage(external.binding, owner) ? external : undefined;
}

function ownsStorage(binding: Binding, owner: EffectOwner): boolean {
  return ts.isSourceFile(owner) ? !isModuleScope(binding) : inside(binding.scope.node, owner);
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
  if (externalReads(state, receiver, flow.reads ?? [{ path: [], mode: "slots" }], owner, true)) {
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
    const effects = mutationEffectsFromFact(state, fact, write.path, node, owner,
      `mutates caller-owned value ${actual.getText(state.sourceFile)}`, false, true, slots);
    return { ...effects, writes: effects.writes.map((forwarded) => ({ ...forwarded, writeNode: write.writeNode ?? write.node })) };
  }));
}

function instantiateDeferredCalls(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  deferredCalls: readonly DeferredCall[],
  actualFact: (index: number) => StorageFact,
  node: ts.Node,
  owner: EffectOwner,
  sourceOwner: EffectOwner,
): CallEffects {
  return combineEffects(deferredCalls.map((call) => {
    const argumentOwner = call.argumentOwner === sourceOwner ? invocationFactOwner(state, owner) : call.argumentOwner;
    const facts = call.argumentOwner === sourceOwner ? call.argumentFacts.map((fact) => instantiateStorageFact(fact, actualFact)) : call.argumentFacts;
    if (call.callee.kind === "parameter" && call.owner !== sourceOwner) {
      return { flows: [], writes: [], deferredCalls: [{ ...call, node, argumentOwner, argumentFacts: facts }] };
    }
    const callee = call.callee.kind === "parameter" ? actualFact(call.callee.parameterIndex) : invocationBinding(state, call.callee.binding);
    if (!callee) { return { flows: [], writes: [], deferredCalls: [{ ...call, node, argumentOwner, argumentFacts: facts }] }; }
    return instantiateSummaryDeferredCall(state, summaries, sourceOwner, { callee, facts, point: node, owner });
  }));
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
  const deferredCalls: DeferredCall[] = [];
  for (const target of targets) {
    const callbackSummary = summaries.get(target);
    if (!callbackSummary) {
      continue;
    }
    const effects = instantiateCallableSummaryFromFacts(state, summaries, callbackSummary, argumentFacts, node, owner);
    flows.push(...effects.flows);
    writes.push(...effects.writes);
    deferredCalls.push(...effects.deferredCalls);
  }
  return { flows, writes, deferredCalls };
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
    const slots = transferredPushSlots(state, fact, { ...write, repeated: true }, summary.owner, node, owner, write.path);
    const effects = mutationEffectsFromFact(state, fact, write.path, node, owner, "mutates caller-owned callback argument", false, true, slots);
    return { ...effects, writes: effects.writes.map((forwarded) => ({ ...forwarded, writeNode: write.writeNode ?? write.node })) };
  });
  const callbacks = instantiateDeferredCalls(state, summaries, summary.deferredCalls, actualFact, node, owner, summary.owner);
  return combineEffects([...rebound, ...writes, callbacks]);
}

function bareParameterFactIndex(fact: StorageFact): number | undefined {
  if (fact.outer.length !== 1) { return undefined; }
  const parameter = parameterProjection(fact.outer[0]);
  return parameter?.path.length === 0 ? parameter.parameterIndex : undefined;
}

function invocationFactOwner(state: AnalysisState, owner: EffectOwner): EffectOwner {
  return state.invocation?.stack[0] ?? owner;
}

function instantiateSummaryDeferredCall(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  summaryOwner: EffectOwner,
  request: Pick<InvocationRequest, "callee" | "facts" | "point" | "owner">,
): CallEffects {
  const { callee, facts, point, owner } = request;
  const parameterIndex = bareParameterFactIndex(callee);
  if (parameterIndex !== undefined) {
    return { flows: [], writes: [], deferredCalls: [{ owner: invocationFactOwner(state, owner), argumentOwner: invocationFactOwner(state, owner), callee: { kind: "parameter", parameterIndex }, node: point, argumentFacts: facts }] };
  }
  if (state.summarySubstitutions?.has(summaryOwner)) {
    escapeStorage(state, facts, point, owner);
    return unknownEffects(point, owner, "calls unresolved callable");
  }
  const active = state.invocation;
  if (!active || !registeredInvocationCallee(active, callee)) {
    escapeStorage(state, facts, point, owner);
  }
  const evaluated = evaluateInvocation({ ...state, summarySubstitutions: new Set([...(state.summarySubstitutions ?? []), summaryOwner]) }, summaries, {
    ...request,
    actuals: [],
    forceGenerator: false,
    execution: "callback",
  });
  return evaluated?.effects ?? unknownEffects(point, owner, "calls unresolved callable");
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
  const receiver = fact.outer.some((origin) => origin.startsWith("host:"))
    ? joinStorageFacts([fact, unknownFact]) : fact;
  return mutationEffectsFromFact(state, receiver, "outer", call.expression, owner,
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
  if ((!isAccessExpression(member)) || namedRoot(member)) {
    return emptyCallEffects();
  }
  const fact = storageFactForExpression(state, summaries, member.expression, owner, node);
  const indexes = parameterOriginIndexes(fact.outer);
  return mutationEffectsFromFact(state, fact, "outer", member, owner,
    indexes.length === 1 ? `mutates argument ${parameterName(owner, indexes[0])}` : "mutates caller-owned value", false, false, [storageSlot(member)]);
}

function namedRoot(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (isAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword;
}

function boundRoot(state: AnalysisState, expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (isAccessExpression(current)) {
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
  if (!classes.complete) {
    if (classes.targets.length === 0 && isPureConstructor(globalName(expression, state.model))) {
      return emptyCallEffects();
    }
    escapeStorage(state, actuals.map((actual) =>
      storageFactForExpression(state, summaries, ts.isSpreadElement(actual) ? actual.expression : actual, owner, node)), node, owner);
    const effects = classes.targets.flatMap(created => {
      const summary = summaries.get(explicitConstructor(created) ?? created);
      return summary ? [instantiateCallableSummary(state, summaries, summary, actuals, node, owner, unknownFact)] : [];
    });
    return combineEffects([...effects, unknownEffects(node, owner, "constructs unresolved class")]);
  }
  return combineEffects(classes.targets.map((created) => {
    const target = explicitConstructor(created) ?? created;
    const active = state.invocation;
    if (active) {
      const invocation = ts.isNewExpression(node.parent) ? node.parent : undefined;
      const prior = invocation && active.calls.get(invocation);
      if (prior) { return prior.effects; }
      const result = evaluateInvocation(state, summaries, {
        callee: callableFact(active, target, active.frame),
        facts: actuals.map((actual) => storageFactForExpression(state, summaries, actual, owner, node)),
        point: node,
        owner,
        actuals,
        receiver: privateFact,
        forceGenerator: false,
        execution: "once",
      });
      if (result) {
        if (invocation) { active.calls.set(invocation, result); }
        return result.effects;
      }
    }
    const summary = summaries.get(target);
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
  return combineEffects(accessorKinds(wrapped).filter((kind) => kind !== "set").map((kind) => accessorKindEffects(state, summaries, node, owner, kind)));
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
  if (resolved.targets.length === 0 && !resolution.isDecorated(resolved)) {
    return emptyCallEffects();
  }
  const receiver = isAccessExpression(node)
    ? storageFactForExpression(state, summaries, node.expression, owner, node) : unknownFact;
  const parent = outerExpression(node).parent;
  const actuals = kind === "set" && ts.isBinaryExpression(parent) ? [parent.right] : [];
  const groups = resolved.targets.flatMap((target) => {
    const active = state.invocation;
    if (active) {
      const result = evaluateInvocation(state, summaries, {
        callee: callableFact(active, target, active.frame),
        facts: actuals.map((actual) => storageFactForExpression(state, summaries, actual, owner, node)),
        point: node,
        owner,
        actuals,
        receiver,
        forceGenerator: false,
        execution: "once",
      });
      if (result) { return [result.effects]; }
    }
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
  if (isAccessExpression(parent)) {
    const member = outerExpression(parent);
    return !isCallee(member) && isInertUse(model, member);
  }
  if (ts.isBinaryExpression(parent)) {
    return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
  }
  if (ts.isPrefixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.ExclamationToken;
  }
  return ts.isCallExpression(parent) ? isInertArgument(model, parent) : isDiscarded(parent);
}

function isInertArgument(model: ScopeModel, call: ts.CallExpression): boolean {
  const known = libraryCall(call, model);
  if (known?.kind === "mutating") {
    return known.target === "receiver";
  }
  return known?.kind === "pure" && known.result === "fresh" && known.callbacks.length === 0 && iteratedArgument(call, model) === undefined;
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
  if ((isAccessExpression(parent)) &&
      ["next", "return", "throw"].includes(methodName(parent) ?? "") && isCallee(outerExpression(parent))) {
    return outerExpression(parent).parent;
  }
  return undefined;
}

function isCallee(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
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

/** Runs a generator body where an owner enumerates a generator object that an enclosing owner created and stored. */
function sharedGeneratorEffects(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, node: ts.Node, owner: EffectOwner,
): CallEffects | undefined {
  const groups = sharedGeneratorCalls(state, expression, owner)?.map((call) => generatorBodyEffects(state, summaries, call, node, owner));
  return groups?.every((group) => group) ? combineEffects(groups.flatMap((group) => group ?? [])) : undefined;
}

/** Lists the calls an enclosing owner stored in the binding, when every value the binding holds comes from one. */
function sharedGeneratorCalls(state: AnalysisState, expression: ts.Expression, owner: EffectOwner): readonly ts.CallExpression[] | undefined {
  const value = unwrapExpression(expression);
  const binding = ts.isIdentifier(value) ? state.model.resolve(value) : undefined;
  const home = binding && declaringOwner(state, binding);
  if (!binding || home === owner || (home && !inside(owner, home))) {
    return undefined;
  }
  const values = bindingAssignments(binding).map((assignment) => assignment.value && unwrapExpression(assignment.value));
  const calls = values.filter((call): call is ts.CallExpression => !!call && ts.isCallExpression(call));
  return calls.length > 0 && calls.length === values.length ? calls : undefined;
}

function generatorBodyEffects(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, node: ts.Node, owner: EffectOwner,
): CallEffects[] | undefined {
  const targets = callableTargets(state, summaries, call.expression);
  if (!targets?.length || !targets.every(isGenerator)) {
    return undefined;
  }
  const bodies = targets.flatMap((target) => summaries.get(target) ?? []);
  const captures = capturesForExpression(state, summaries, call.expression, owner, new Set());
  return bodies.length === targets.length ? bodies.map((summary) => {
    const body = defaultEffects(summary, false);
    return instantiateCallableSummary(state, summaries, { ...summary, flows: body.flows, parameterWrites: body.writes, deferredCalls: body.deferredCalls },
      call.arguments, node, owner, undefined, captures);
  }) : undefined;
}

function frameForBinding(state: AnalysisState, binding: Binding): LexicalFrame | undefined {
  let frame = state.invocation?.frame;
  const home = declaringOwner(state, binding);
  if (home && ts.isSourceFile(home)) { return undefined; }
  while (frame) {
    if (frame.owner === home) {
      return frame;
    }
    frame = frame.parent;
  }
  return undefined;
}

function resolvedReassignment(state: AnalysisState, flow: ImplicitFlow): boolean {
  return flow.binding !== undefined && flow.access === "reassign" && hasLexicalCell(state, flow.binding);
}

function hasLexicalCell(state: AnalysisState, binding: Binding): boolean {
  const frame = frameForBinding(state, binding);
  return frame !== undefined && state.invocation?.store.has(cellKey(frame, binding)) === true;
}

function cellKey(frame: LexicalFrame, binding: Binding): string {
  return `${frame.id}/${binding.declarations[0].identifier.getStart()}`;
}

function invocationBinding(state: AnalysisState, binding: Binding): StorageFact | undefined {
  const active = state.invocation;
  if (!active) {
    return undefined;
  }
  const target = binding.declarations.map((item) => item.node).find(isFunctionLikeWithBody);
  const frame = frameForBinding(state, binding);
  if (target) {
    let lexical = active.frame;
    while (lexical.parent && !inside(target, lexical.owner)) {
      lexical = lexical.parent;
    }
    return callableFact(active, target, lexical);
  }
  if (!frame) {
    return undefined;
  }
  const stored = active.store.get(cellKey(frame, binding));
  if (stored) {
    return stored;
  }
  return undefined;
}

function moduleCallableShape(state: AnalysisState, binding: Binding, site: ts.Node): StorageFact | undefined {
  const active = state.invocation;
  const literal = moduleObjectInitializer(binding);
  const reference = binding.references[0];
  if (!active || !literal || !reference || !closedContainerBinding(state.model, binding, literal, new Set()) ||
      !receiverShapes(state.model, reference, new Set(), site).complete) { return undefined; }
  const origin = externalBindingOrigin(binding);
  const base: StorageFact = { outer: [origin], reachable: [origin] };
  return moduleLiteralFact(state, active, literal, base);
}

function moduleObjectInitializer(binding: Binding): ts.ObjectLiteralExpression | undefined {
  const declaration = binding.declarations.length === 1 ? binding.declarations[0].node : undefined;
  if (binding.scope.kind !== "file" || !declaration || !ts.isVariableDeclaration(declaration) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer) { return undefined; }
  const value = unwrapExpression(declaration.initializer);
  return ts.isObjectLiteralExpression(value) ? value : undefined;
}

function closedContainerBinding(model: ScopeModel, binding: Binding, literal: ts.ObjectLiteralExpression, seen: ReadonlySet<Binding>): boolean {
  if (isExportedBinding(binding) || bindingAssignments(binding).length !== 1) { return false; }
  return seen.has(binding) || binding.references.every((reference) =>
    closedContainerUse(model, reference, literal, new Set(seen).add(binding)));
}

function closedContainerUse(model: ScopeModel, node: ts.Expression, literal: ts.ObjectLiteralExpression, seen: ReadonlySet<Binding>): boolean {
  const value = outerExpression(node);
  const parent = value.parent;
  if (isAccessExpression(parent) && parent.expression === value) {
    const name = methodName(parent);
    if (name === undefined) { return false; }
    const nested = nestedContainer(literal, name);
    return !nested || closedContainerUse(model, parent, nested, seen);
  }
  return ts.isVariableDeclaration(parent) && parent.initializer === value &&
    closedContainerPattern(model, parent.name, literal, seen);
}

function closedContainerPattern(model: ScopeModel, name: ts.BindingName, literal: ts.ObjectLiteralExpression, seen: ReadonlySet<Binding>): boolean {
  if (ts.isIdentifier(name)) {
    const binding = model.bindings.find((item) => item.declarations.some((declaration) => declaration.identifier === name));
    return !!binding && closedContainerBinding(model, binding, literal, seen);
  }
  return ts.isObjectBindingPattern(name) && name.elements.every((element) => {
    if (element.dotDotDotToken || element.initializer) { return false; }
    const key = keyName(element.propertyName ?? element.name);
    if (key === undefined) { return false; }
    const nested = nestedContainer(literal, key);
    return !nested || closedContainerPattern(model, element.name, nested, seen);
  });
}

function nestedContainer(literal: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | undefined {
  const property = literal.properties.find((member) => !ts.isSpreadAssignment(member) && keyName(member.name) === name);
  const value = property && ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : undefined;
  return value && ts.isObjectLiteralExpression(value) ? value : undefined;
}

function stableLiteral(model: ScopeModel, literal: ts.ObjectLiteralExpression): boolean {
  const names = new Set<string>();
  return literal.properties.every((property) => {
    if (ts.isSpreadAssignment(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property) ||
        ts.isComputedPropertyName(property.name)) { return false; }
    const name = keyName(property.name);
    if (name === undefined || name === "__proto__" || names.has(name)) { return false; }
    names.add(name);
    return !model.writesMemberName(name);
  });
}

function literalReceiverStaysClosed(model: ScopeModel, literal: ts.ObjectLiteralExpression): boolean {
  const visit = (node: ts.Node): boolean => {
    if (ts.isExpression(node) && node.kind === ts.SyntaxKind.ThisKeyword) {
      return closedContainerUse(model, node, literal, new Set());
    }
    return !ts.forEachChild(node, (child) => visit(child) ? undefined : true);
  };
  return visit(literal);
}

function literalCallable(property: ts.ObjectLiteralElementLike): EffectOwner | undefined {
  if (ts.isMethodDeclaration(property) && isFunctionLikeWithBody(property)) { return property; }
  if (!ts.isPropertyAssignment(property)) { return undefined; }
  const value = unwrapExpression(property.initializer);
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : undefined;
}

function moduleLiteralFact(state: AnalysisState, active: InvocationState, literal: ts.ObjectLiteralExpression, base: StorageFact): StorageFact {
  if (!stableLiteral(state.model, literal) || !literalReceiverStaysClosed(state.model, literal) ||
      base.outer.some((origin) => absorbsSlots(externalProjection(origin)?.path ?? []))) { return base; }
  const members = literal.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) { return []; }
    const slot = `property:${keyName(property.name)}`;
    const callable = literalCallable(property);
    if (callable) {
      let lexical = active.frame;
      while (lexical.parent && !inside(property, lexical.owner)) { lexical = lexical.parent; }
      if (!inside(property, lexical.owner)) {
        lexical = { id: ownerKey(state.sourceFile), context: [], owner: state.sourceFile };
      }
      return [{ slot, fact: callableFact(active, callable, lexical) }];
    }
    const value = ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : undefined;
    return value && ts.isObjectLiteralExpression(value)
      ? [{ slot, fact: moduleLiteralFact(state, active, value, memberStorageFact(base, slot)) }] : [];
  });
  return members.length ? knownMemberFact(base, members) : base;
}

function callableFact(active: InvocationState, target: EffectOwner, frame: LexicalFrame): StorageFact {
  const origin: StorageOrigin = `private:${allocationId(target)}:frame=${frame.id}`;
  active.registry.set(origin, { kind: "source", target, frame, receiver: ts.isArrowFunction(target) && !ts.isSourceFile(frame.owner) ? active.receiver : undefined });
  return { outer: [origin], reachable: ["private"], cells: [{ allocation: origin, slot: "@allocation", origins: ["private"] }] };
}

function heapWritesMember(state: AnalysisState, fact: StorageFact, member = ""): boolean {
  return state.invocation?.heap.some((insertion) =>
    (insertion.slot === undefined || insertion.slot === `property:${member}`) &&
    insertion.target.outer.some((origin) => fact.outer.includes(origin))) ?? false;
}

function invocationValue(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, value: ts.Expression): StorageFact | undefined {
  const active = state.invocation;
  if (!active) {
    return undefined;
  }
  if (value.kind === ts.SyntaxKind.ThisKeyword && active.receiver) {
    return active.receiver;
  }
  const cached = active.values.get(value);
  if (cached) {
    return cached;
  }
  const advance = iteratorAdvanceValue(state, summaries, value, active);
  if (advance) { return advance; }
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return callableFact(active, value, active.frame);
  }
  return undefined;
}

function iteratorAdvanceValue(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, value: ts.Expression, active: InvocationState): StorageFact | undefined {
  if ((isAccessExpression(value)) && methodName(value) === "next") {
    const receiver = storageFactForExpression(state, summaries, value.expression, active.frame.owner, value);
    if (!heapWritesMember(state, receiver, "next") && receiver.outer.length > 0 && receiver.outer.every((origin) => invocationInstance(active, origin)?.kind === "iterator")) {
      return joinStorageFacts(receiver.outer.map((iterator) => {
        const origin: StorageOrigin = `private:${allocationId(value)}:advance=${iterator}`;
        active.registry.set(origin, { kind: "advance", iterator });
        return { outer: [origin], reachable: ["private"] };
      }));
    }
  }
  return undefined;
}

function invocationEvent(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Node, owner: EffectOwner): void {
  const active = state.invocation;
  if (!active) {
    return;
  }
  recordInvocationEvent(state, summaries, node, owner, active);
  state.factCache.clear();
  state.insertionCache.clear();
  if (ts.isExpression(node) && (!ts.isIdentifier(node) || state.model.isReference(node))) {
    cacheInvocationValue(state, summaries, node, owner, active);
  }
}

function recordInvocationEvent(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Node, owner: EffectOwner, active: InvocationState): void {
  escapeComputedKey(state, summaries, node, owner);
  if (ts.isVariableDeclaration(node) && node.initializer) {
    recordVariableAssignment(state, summaries, node, owner, active, node.initializer);
  } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || isShortCircuit(node.operatorToken.kind))) {
    recordBinaryAssignment(state, summaries, node, owner, active);
  } else if (ts.isCallExpression(node)) {
    executeInvocation(state, summaries, node, owner);
  }
}

function escapeComputedKey(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Node, owner: EffectOwner): void {
  const key = ts.isElementAccessExpression(node) ? node.argumentExpression
    : ts.isComputedPropertyName(node) ? node.expression : undefined;
  if (key && !supportsProtocol(state.model, key, "convert")) {
    escapeStorage(state, [storageFactForExpression(state, summaries, key, owner, node)], node, owner);
  }
}

function recordVariableAssignment(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.VariableDeclaration, owner: EffectOwner, active: InvocationState, initializer: ts.Expression): void {
  for (const [binding, assignment] of assignedAt(state, "declared", node)) {
    const frame = frameForBinding(state, binding);
    if (frame) {
      const fact = storageFactForExpression(state, summaries, initializer, owner, node);
      active.store.set(cellKey(frame, binding), selectedFact(fact, assignment, (expression) => storageFactForExpression(state, summaries, expression, owner, node)));
    }
  }
}

function recordBinaryAssignment(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.BinaryExpression, owner: EffectOwner, active: InvocationState): void {
  for (const binding of bindingsReferencedIn(state, node.left)) {
    const assignment = binding.references.filter((reference) => inside(reference, node.left)).map(referenceAssignment).find((item) => item !== undefined);
    const frame = frameForBinding(state, binding);
    if (assignment) { escapeModuleAssignment(state, summaries, binding, assignment, node, owner); }
    if (assignment && frame) {
      const source = assignment.value ? storageFactForExpression(state, summaries, assignment.value, owner, node) : unknownFact;
      const next = selectedFact(source, assignment, (expression) => storageFactForExpression(state, summaries, expression, owner, node));
      const key = cellKey(frame, binding);
      active.store.set(key, assignment.join ? joinStorageFacts([active.store.get(key) ?? storageFactForBinding(state, summaries, binding, owner, node.left), next]) : next);
    }
  }
}

/** Gives each binding, in model order, with its first assignment at the node; iterated assignments are indexed apart. */
function assignedAt(state: AnalysisState, kind: "declared" | "iterated", node: ts.Node): readonly (readonly [Binding, Assignment])[] {
  let index = state.assignmentSites[kind];
  if (!index) {
    index = new Map();
    for (const binding of state.model.bindings) {
      const seen = new Set<ts.Node>();
      for (const assignment of cachedAssignments(state, binding)) {
        if ((kind === "declared" || assignment.iterated) && !seen.has(assignment.node)) {
          seen.add(assignment.node);
          index.set(assignment.node, [...index.get(assignment.node) ?? [], [binding, assignment]]);
        }
      }
    }
    state.assignmentSites[kind] = index;
  }
  return index.get(node) ?? [];
}

/** Gives the bindings, in model order, with a reference inside the node. */
function bindingsReferencedIn(state: AnalysisState, node: ts.Node): Binding[] {
  let references = state.assignmentSites.references;
  if (!references) {
    references = state.model.bindings.flatMap((binding, order) => binding.references.map((reference) => [reference, order] as const))
      .sort((left, right) => left[0].pos - right[0].pos);
    state.assignmentSites.references = references;
  }
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (references[middle][0].pos < node.pos) { low = middle + 1; } else { high = middle; }
  }
  const orders = new Set<number>();
  for (let index = low; index < references.length && references[index][0].pos <= node.end; index++) {
    if (inside(references[index][0], node)) { orders.add(references[index][1]); }
  }
  return [...orders].sort((left, right) => left - right).map((order) => state.model.bindings[order]);
}

function escapeModuleAssignment(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, binding: Binding, assignment: Assignment, node: ts.Node, owner: EffectOwner): void {
  if (isModuleScope(binding) && owner !== state.sourceFile && assignment.value) {
    escapeStorage(state, [storageFactForExpression(state, summaries, assignment.value, owner, node)], node, owner);
  }
}

function cacheInvocationValue(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Expression, owner: EffectOwner, active: InvocationState): void {
  const fact = storageFactForExpression(state, summaries, node, owner, node);
  const allocation: StorageOrigin = `private:${allocationId(node)}`;
  const rebase = (origins: readonly StorageOrigin[]): readonly StorageOrigin[] => origins.map((origin): StorageOrigin =>
    origin === allocation ? `private:${allocationId(node)}:frame=${active.frame.id}` : origin);
  active.values.set(node, mapStorageFact(fact, rebase, rebase));
}

function joinBindingStores(initial: ReadonlyMap<string, StorageFact>, branches: readonly ReadonlyMap<string, StorageFact>[]): Map<string, StorageFact> {
  const keys = new Set(branches.flatMap((branch) => [...branch.keys()]));
  return new Map([...keys].map((key) => [key, joinStorageFacts(branches.map((branch) => branch.get(key) ?? initial.get(key) ?? unknownFact))]));
}

function invocationStateKey(active: InvocationState): string {
  const registry = [...active.registry].map(([origin, instance]) => [origin, instance.kind === "source"
    ? [instance.kind, instance.target.getStart(), instance.frame.id, instance.receiver]
    : instance.kind === "iterator" ? [instance.kind, instance.source.target.getStart(), instance.source.frame.id, instance.facts, instance.receiver]
      : instance.kind === "bound" ? [instance.kind, instance.callee, instance.receiver, instance.facts]
        : instance]);
  return JSON.stringify([ [...active.store], active.heap.map((insertion) =>
    [insertion.target, insertion.slot, insertion.value, insertion.replace]), [...active.arrays], registry ]);
}

const heapWriteKeySymbol = Symbol("explicitnessHeapWriteKey");
type KeyedInsertion = StorageInsertion & { [heapWriteKeySymbol]?: string };

// The key is not enumerable, so a spread copy that changes the write computes its own.
function heapWriteKey(insertion: StorageInsertion): string {
  const keyed = insertion as KeyedInsertion;
  const known = keyed[heapWriteKeySymbol];
  if (known !== undefined) { return known; }
  const key = JSON.stringify([insertion.target, insertion.slot, insertion.value]);
  Object.defineProperty(keyed, heapWriteKeySymbol, { value: key });
  return key;
}

/**
 * Appends heap writes, leaving out a weak write that repeats an earlier one when nothing in between wrote to its
 * storage. Joining the same value into the same cells twice changes nothing, so every later read sees the same heap.
 */
function pushHeap(heap: StorageInsertion[], insertions: readonly StorageInsertion[]): void {
  for (const insertion of insertions) {
    if (!repeatsHeapWrite(heap, insertion)) { heap.push(insertion); }
  }
}

function repeatsHeapWrite(heap: readonly StorageInsertion[], insertion: StorageInsertion): boolean {
  if (insertion.kind !== "cell" || insertion.replace) { return false; }
  for (let index = heap.length - 1; index >= 0 && index >= heap.length - 64; index -= 1) {
    const earlier = heap[index];
    if (earlier.kind === "cell" && !earlier.replace && heapWriteKey(earlier) === heapWriteKey(insertion)) { return true; }
    if (earlier.target.outer.some((origin) => insertion.target.outer.includes(origin))) { return false; }
  }
  return false;
}

function joinInvocationHeaps(prefix: readonly StorageInsertion[], branches: readonly (readonly StorageInsertion[])[]): StorageInsertion[] {
  const groups = new Map<string, { insertion: StorageInsertion; values: StorageFact[]; branches: Set<number>; replace: boolean }>();
  branches.forEach((branch, index) => {
    for (const insertion of branch.slice(prefix.length)) {
      const key = JSON.stringify([insertion.kind, insertion.target.outer, insertion.slot]);
      const group = groups.get(key) ?? { insertion, values: [], branches: new Set<number>(), replace: true };
      group.values.push(insertion.value);
      group.branches.add(index);
      group.replace &&= insertion.replace;
      groups.set(key, group);
    }
  });
  return [...prefix, ...[...groups.values()].map((group) => ({ ...group.insertion,
    value: joinStorageFacts(group.values), replace: group.replace && group.branches.size === branches.length }))];
}

function executeInvocation(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, owner: EffectOwner): void {
  const active = state.invocation;
  if (!active || active.calls.has(call)) {
    return;
  }
  const expression = unwrapExpression(call.expression);
  const facts = call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call));
  if (bindInvocation(state, summaries, call, owner, active, expression, facts)) { return; }
  const callee = invocationCallee(state, summaries, call, owner, active, expression);
  const result = evaluateInvocation(state, summaries, {
    callee,
    facts,
    point: call.expression,
    owner,
    actuals: call.arguments,
    receiver: callReceiver(state, summaries, call, owner),
    forceGenerator: false,
    execution: "once",
  });
  if (result) {
    active.calls.set(call, result);
    active.values.set(call, result.value);
  }
}

function bindInvocation(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, owner: EffectOwner, active: InvocationState, expression: ts.Expression, facts: readonly StorageFact[]): boolean {
  if ((isAccessExpression(expression)) && methodName(expression) === "bind") {
    const callee = storageFactForExpression(state, summaries, expression.expression, owner, call);
    if (!heapWritesMember(state, callee, "bind") && callee.outer.length > 0 && callee.outer.every((origin) => {
      const instance = invocationInstance(active, origin);
      return instance !== undefined && instance.kind !== "iterator";
    })) {
      const origin: StorageOrigin = `private:${allocationId(call)}:bound=${active.frame.id}`;
      active.registry.set(origin, { kind: "bound", callee, receiver: facts[0] ?? privateFact, facts: facts.slice(1), actuals: call.arguments.slice(1) });
      const value: StorageFact = { outer: [origin], reachable: ["private"] };
      active.calls.set(call, { effects: emptyCallEffects(), value });
      active.values.set(call, value);
      return true;
    }
  }
  return false;
}

function invocationCallee(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, call: ts.CallExpression, owner: EffectOwner, active: InvocationState, expression: ts.Expression): StorageFact {
  let callee = storageFactForExpression(state, summaries, call.expression, owner, call);
  if (!callee.outer.some((origin) => invocationInstance(active, origin) !== undefined) &&
      !((isAccessExpression(expression)) &&
        heapWritesMember(state, storageFactForExpression(state, summaries, expression.expression, owner, call), methodName(expression) ?? ""))) {
    const resolved = resolveTargets(dispatchFor(state, summaries), call.expression);
    if (resolved.complete && resolved.targets.length > 0 && resolved.targets.every((target) => ts.isMethodDeclaration(target) && !isGenerator(target))) {
      callee = joinStorageFacts(resolved.targets.map((target) => {
        let lexical = active.frame;
        while (lexical.parent && !inside(target, lexical.owner)) {
          lexical = lexical.parent;
        }
        return callableFact(active, target, lexical);
      }));
    }
  }
  return callee;
}

function hasOwnedOutput(state: AnalysisState, flow: ImplicitFlow, owner: EffectOwner): boolean {
  return flow.kind === "output" && flow.origins?.some((origin) => ownedOrigin(state, origin, owner)) === true;
}

function invocationFlow(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, flow: ImplicitFlow, facts: readonly StorageFact[], actuals: readonly ts.Expression[], point: ts.Node, owner: EffectOwner, lexical: AnalysisState): CallEffects {
  if (resolvedReassignment(lexical, flow)) { return emptyCallEffects(); }
  if (flow.binding && ownsStorage(flow.binding, owner)) {
    return ownedBindingFlow(state, summaries, flow, flow.binding, point, owner);
  }
  if (hasOwnedOutput(state, flow, owner)) {
    return forwardedFlow(state, summaries, flow, point, owner);
  }
  const moved = movedInvocationFlow(state, flow, actuals, point, owner);
  if (moved.argumentWrite !== "value" || !flow.origins?.length) { return { flows: [moved], writes: [], deferredCalls: [] }; }
  return callerWriteFlow(state, moved, flow.origins, facts, actuals);
}

function callerWriteFlow(state: AnalysisState, moved: ImplicitFlow, origins: readonly StorageOrigin[], facts: readonly StorageFact[], actuals: readonly ts.Expression[]): CallEffects {
  const roots = origins.flatMap((origin) => externalProjection(origin)?.base ?? []);
  const index = facts.findIndex((fact) => [...fact.outer, ...fact.reachable].some((origin) => {
    const base = externalProjection(origin)?.base;
    return base !== undefined && roots.includes(base);
  }));
  const actual = actuals[index];
  return { flows: [actual ? { ...moved, description: `mutates caller-owned value ${actual.getText(state.sourceFile)}` } : moved], writes: [], deferredCalls: [] };
}

function movedInvocationFlow(state: AnalysisState, flow: ImplicitFlow, actuals: readonly ts.Expression[], point: ts.Node, owner: EffectOwner): ImplicitFlow {
  const readSite = flow.kind === "input" && flow.readParameterIndex !== undefined ? actuals[flow.readParameterIndex] : undefined;
  return { ...movedFlow(flow, readSite ?? point, owner, flow.origins), readParameterIndex: undefined,
    argumentWrite: flow.argumentWrite ?? (flow.kind === "output" ? argumentWriteForOrigins(state, flow.origins ?? [], owner) : undefined) };
}

function isAsync(owner: EffectOwner): boolean {
  return ts.canHaveModifiers(owner) && !!ts.getModifiers(owner)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function promiseFact(point: ts.Node, settled: StorageFact, context: string): StorageFact {
  const allocation: StorageOrigin = `private:${allocationId(point)}`;
  const origin: StorageOrigin = `private:${allocationId(point)}:promise=${context}`;
  const rebase = (origins: readonly StorageOrigin[]) => origins.map((value) => value === allocation ? origin : value);
  return mapStorageFact(allocatedFact(point, [{ slot: "promise:settled", fact: settled }]), rebase, rebase);
}

type InvocationRequest = {
  readonly callee: StorageFact;
  readonly facts: readonly StorageFact[];
  readonly point: ts.Node;
  readonly owner: EffectOwner;
  readonly actuals: readonly ts.Expression[];
  readonly receiver?: StorageFact;
  readonly forceGenerator: boolean;
  readonly execution: "once" | "callback";
};

type InvocationResult = { readonly effects: CallEffects; readonly value: StorageFact };

function invocationInstance(active: InvocationState, origin: StorageOrigin): CallableInstance | undefined {
  const registered = active.registry.get(origin);
  if (registered) { return registered; }
  const semantics = libraryCallbackNamed(hostName(origin));
  return semantics ? { kind: "library", semantics } : undefined;
}

function registeredInvocationCallee(active: InvocationState, callee: StorageFact): boolean {
  return callee.outer.length > 0 && callee.outer.every((origin) => {
    const instance = invocationInstance(active, origin);
    return instance !== undefined && instance.kind !== "iterator";
  });
}

function evaluateInvocation(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, request: InvocationRequest): InvocationResult | undefined {
  const { callee, point, owner } = request;
  const active = state.invocation;
  if (!active) { return undefined; }
  const instances = callee.outer.flatMap((origin) => {
    const found = invocationInstance(active, origin);
    return found && found.kind !== "iterator" ? [found] : [];
  });
  if (!instances.length) {
    return undefined;
  }
  const complete = registeredInvocationCallee(active, callee);
  const member = ts.isExpression(point) ? unwrapExpression(point) : point;
  const unresolved = isAccessExpression(member) ? "calls overridable method" : "calls unresolved callable";
  const groups: CallEffects[] = complete ? [] : [unknownEffects(point, owner, unresolved)];
  const returns: StorageFact[] = complete ? [] : [unknownFact];
  const stores: Map<string, StorageFact>[] = [];
  const arrays: Map<StorageOrigin, PushStart | undefined>[] = [];
  const heapPrefix = [...active.heap];
  const context: InvocationContext = { state, summaries, request, active, instances, complete, unresolved, groups, returns, stores, arrays, heapPrefix };
  for (const instance of instances) {
    evaluateAlternative(context, instance);
  }
  return mergeInvocationAlternatives(context);

}

type InvocationContext = {
  readonly state: AnalysisState;
  readonly summaries: ReadonlyMap<EffectOwner, CallableSummary>;
  readonly request: InvocationRequest;
  readonly active: InvocationState;
  readonly instances: readonly Exclude<CallableInstance, { kind: "iterator" }>[];
  readonly complete: boolean;
  readonly unresolved: string;
  readonly groups: CallEffects[];
  readonly returns: StorageFact[];
  readonly stores: Map<string, StorageFact>[];
  readonly arrays: Map<StorageOrigin, PushStart | undefined>[];
  readonly heapPrefix: readonly StorageInsertion[];
};

function mergeInvocationAlternatives(context: InvocationContext): InvocationResult {
  const { state, active, stores, complete, arrays, groups, returns } = context;
  const { execution } = context.request;
  for (const store of stores) {
    for (const [key, value] of store) {
      active.store.set(key, stores.length === 1 && complete && execution === "once" ? value : joinStorageFacts([active.store.get(key) ?? unknownFact, value]));
    }
  }
  active.arrays = joinArrayStates(state, active.arrays, complete && execution === "once" ? arrays : [active.arrays, ...arrays]);
  const result = { effects: combineEffects(groups), value: joinStorageFacts(returns) };
  return result;
}

function evaluateAdvanceAlternative(context: InvocationContext, instance: Extract<CallableInstance, { kind: "advance" }>): void {
  const { state, summaries, active, unresolved, groups, returns, stores, arrays } = context;
  const { point, owner, receiver, execution } = context.request;
  const iterator = active.registry.get(instance.iterator);
  if (iterator?.kind !== "iterator" || !receiver?.outer.includes(instance.iterator)) {
    groups.push(unknownEffects(point, owner, unresolved));
    returns.push(unknownFact);
    return;
  }
  const callee = callableFact(active, iterator.source.target, iterator.source.frame);
  const result = evaluateInvocation(state, summaries, {
    callee,
    facts: iterator.facts,
    point,
    owner,
    actuals: iterator.actuals,
    receiver: iterator.receiver,
    forceGenerator: true,
    execution,
  });
  groups.push(result?.effects ?? unknownEffects(point, owner, unresolved));
  returns.push(allocatedFact(point, [{ slot: "property:value", fact: result?.value ?? unknownFact }]));
  stores.push(new Map(active.store));
  arrays.push(new Map(active.arrays));
  return;
}

function evaluateBoundAlternative(context: InvocationContext, instance: Extract<CallableInstance, { kind: "bound" }>): void {
  const { state, summaries, active, heapPrefix, groups, returns, stores, arrays, complete, instances, unresolved } = context;
  const { facts, point, owner, actuals, forceGenerator, execution } = context.request;
  const invocation: InvocationState = { ...active, storageWrites: [], arrayResets: [], store: new Map(active.store), heap: [...heapPrefix], arrays: new Map(active.arrays), values: new Map(active.values), calls: new Map(active.calls) };
  const child = { ...state, invocation, factCache: new Map<string, StorageFact>(), insertionCache: new Map<string, readonly StorageInsertion[]>() };
  const result = evaluateInvocation(child, summaries, {
    callee: instance.callee,
    facts: [...instance.facts, ...facts],
    point,
    owner,
    actuals: [...instance.actuals, ...actuals],
    receiver: instance.receiver,
    forceGenerator,
    execution,
  });
  groups.push(result?.effects ?? unknownEffects(point, owner, unresolved));
  returns.push(result?.value ?? unknownFact);
  stores.push(invocation.store);
  arrays.push(invocation.arrays);
  pushHeap(active.heap, invocation.heap.slice(heapPrefix.length).map((insertion) => ({ ...insertion,
    replace: insertion.replace && complete && instances.length === 1 && execution === "once" })));
  active.storageWrites.push(...invocation.storageWrites.map((insertion) => ({ ...insertion,
    node: invocationAt(context.request.point) ?? context.request.point,
    replace: insertion.replace && complete && instances.length === 1 && execution === "once" && unconditional(context.request.point, context.request.owner) })));
  active.arrayResets.push(...invocation.arrayResets);
  return;
}

function evaluateLibraryAlternative(context: InvocationContext, instance: Extract<CallableInstance, { kind: "library" }>): void {
  const { active, groups, returns } = context;
  const { facts, point, owner } = context.request;
  if (instance.semantics.kind === "effect") {
    const [kind, label] = instance.semantics.flow;
    const direct = ts.isExpression(point) && globalName(point, context.state.model) !== undefined;
    const description = kind === "input" && direct ? `${label}()` : label;
    groups.push({ flows: [{ kind, description, node: point, owner }], writes: [], deferredCalls: [] });
    returns.push(privateFact);
  } else {
    const reads = instance.semantics.call.reads;
    facts.forEach((fact, index) => {
      const mode = reads.arguments[index] ?? reads.rest;
      const binding = externalReads(context.state, fact, [{ path: [], mode }], owner, false);
      if (binding) {
        groups.push({ flows: [{ kind: "input", node: point, owner, binding, access: "read", description: `reads ${binding.name}` }], writes: [], deferredCalls: [] });
      }
    });
    const settled = facts[0] ?? privateFact;
    switch (instance.semantics.call.result) {
      case "promise": returns.push(promiseFact(point, settled, active.frame.id)); break;
      case "promise-elements": returns.push(promiseFact(point, shallowStorageFact(point, settled), active.frame.id)); break;
      case "fresh": returns.push(privateFact); break;
      default: returns.push(unknownFact);
    }
  }
  return;
}

function evaluateSourceAlternative(context: InvocationContext, instance: Extract<CallableInstance, { kind: "source" }>): void {
  const { state, summaries, active, groups, returns } = context;
  const { forceGenerator, facts, point, owner, actuals } = context.request;
  const deferred = isGenerator(instance.target) && !forceGenerator;
  const invocation = sourceInvocation(context, instance, deferred);
  const frame = invocation.frame;
  const child = { ...state, invocation, factCache: new Map<string, StorageFact>(), insertionCache: new Map<string, readonly StorageInsertion[]>() };
  ownerParameters(instance.target).forEach((parameter, index) => {
    const binding = state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parameter));
    if (binding) {
      invocation.store.set(cellKey(frame, binding), facts[index] ?? unknownFact);
    }
  });
  if (!deferred && active.stack.includes(instance.target)) {
    const approximation = summaries.get(instance.target);
    if (approximation) {
      groups.push({ flows: applyRecursiveStorage(child, approximation, facts, point).map((binding) => ({
        kind: "unknown", node: point, owner, binding, access: "reassign",
        description: "has storage writes this analysis did not resolve",
      })), writes: [], deferredCalls: [] });
    }
    groups.push(approximation ? instantiateCallableSummaryFromFacts(child, summaries, approximation, facts, point, owner)
      : unknownEffects(point, owner, "has effects this analysis did not resolve"));
    returns.push(approximation ? instantiateStorageFact(joinStorageFacts(approximation.returnedAliases), (index) => facts[index] ?? unknownFact) : unknownFact);
    mergeSourceState(context, invocation);
    return;
  }
  const summary = summarizeCallable(child, summaries, instance.target, state.includeThis);
  groups.push(combineEffects([
    ...[...summary.flows].sort((left, right) => Number(!!right.argumentWrite) - Number(!!left.argumentWrite)).map((flow) => invocationFlow(state, summaries, flow, facts, actuals, point, owner, child)),
    { flows: [], writes: summary.parameterWrites.map((write) => ({ ...write, node: point, description: `mutates argument ${parameterName(owner, write.parameterIndex)}` })), deferredCalls: [] },
  ]));
  groups.push(instantiateDeferredCalls(child, summaries, summary.deferredCalls, (index) => facts[index] ?? unknownFact, point, owner, instance.target));
  appendSourceReturns(context, instance, invocation, summary, deferred);
  mergeSourceState(context, invocation);
}

function recursiveCaptures(state: AnalysisState, origins: readonly StorageOrigin[]): ReadonlyMap<StorageOrigin, StorageFact> {
  const captures = new Map<StorageOrigin, StorageFact>();
  for (const origin of origins) {
    const capture = originBinding(state, origin);
    const value = capture && invocationBinding(state, capture.binding);
    if (capture && value) {
      captures.set(origin, capture.path.reduce((current, slot) => memberStorageFact(current, slot), value));
    }
  }
  return captures;
}

function recursivePrivateOrigins(active: InvocationState | undefined, origin: StorageOrigin, path: "outer" | "reachable"): readonly StorageOrigin[] {
  if (!active) { return [origin]; }
  const instance = invocationInstance(active, origin);
  if (instance?.kind === "source" && instance.frame.owner === active.frame.owner) {
    return originsForPath(callableFact(active, instance.target, active.frame), path);
  }
  return origin.startsWith("private:") && !instance
    ? [`private:${Number(origin.split(":")[1])}:frame=${active.frame.id}`] : [origin];
}

function recursiveStorageOrigins(state: AnalysisState, origins: readonly StorageOrigin[], path: "outer" | "reachable",
  facts: readonly StorageFact[], captures: ReadonlyMap<StorageOrigin, StorageFact>): readonly StorageOrigin[] {
  return joinStorageOrigins(origins.flatMap((origin): readonly StorageOrigin[] => {
    if (parameterProjection(origin)) { return instantiateOrigins([origin], path, (index) => facts[index] ?? unknownFact); }
    const receiver = state.invocation?.receiver;
    if (origin === "receiver" && receiver) { return originsForPath(receiver, path); }
    const capture = captures.get(origin);
    return capture ? originsForPath(capture, path) : recursivePrivateOrigins(state.invocation, origin, path);
  }));
}

function recursiveReceiverCells(state: AnalysisState, origins: readonly StorageOrigin[]): readonly StorageCell[] {
  return origins.includes("receiver") ? state.invocation?.receiver?.cells ?? [] : [];
}

function recursiveStorageFact(state: AnalysisState, fact: StorageFact, facts: readonly StorageFact[]): StorageFact {
  const origins = [...fact.outer, ...fact.reachable, ...(fact.cells ?? []).flatMap((cell) => [cell.allocation, ...cell.origins])];
  const captures = recursiveCaptures(state, origins);
  const actualFact = (index: number) => facts[index] ?? unknownFact;
  const cells = [...recursiveReceiverCells(state, origins), ...parameterOriginIndexes(origins).flatMap((index) => actualFact(index).cells ?? []),
    ...[...captures.values()].flatMap((capture) => capture.cells ?? [])];
  return mapStorageFact(fact, (origins) => recursiveStorageOrigins(state, origins, "outer", facts, captures),
    (origins) => recursiveStorageOrigins(state, origins, "reachable", facts, captures), cells);
}

function recursiveInsertion(state: AnalysisState, summary: CallableSummary, facts: readonly StorageFact[], insertion: StorageInsertion, point: ts.Node): StorageInsertion {
  const target = recursiveStorageFact(state, calleeOwnCellsRemoved(insertion.target), facts);
  const value = recursiveStorageFact(state, insertion.value, facts);
  const start = insertion.appendCall && knownPushStartFromFact(state, target, summary.owner, insertion.appendCall);
  const slot = insertion.appendCall ? start ? `append:${start.lowerBound}` : undefined : insertion.slot;
  return { ...insertion, node: invocationAt(point) ?? point, target, value, slot, replace: false };
}

function applyRecursiveInsertion(state: AnalysisState, active: InvocationState, insertion: StorageInsertion): Binding | undefined {
  active.storageWrites.push(insertion);
  if (insertion.kind === "cell") {
    pushHeap(active.heap, [insertion]);
    if (insertion.appendCall) {
      const start = insertion.slot?.startsWith("append:") ? { lowerBound: Number(insertion.slot.slice(7)), exact: false } : undefined;
      insertion.target.outer.forEach((origin) => active.arrays.set(origin, start));
    }
  } else {
    const frame = frameForBinding(state, insertion.binding);
    if (frame) {
      const key = cellKey(frame, insertion.binding);
      active.store.set(key, joinStorageFacts([active.store.get(key) ?? unknownFact, insertion.value]));
    } else if (!isModuleScope(insertion.binding)) {
      return insertion.binding;
    }
  }
  return undefined;
}

function applyRecursiveStorage(state: AnalysisState, summary: CallableSummary, facts: readonly StorageFact[], point: ts.Node): readonly Binding[] {
  const active = state.invocation;
  if (!active) { return []; }
  const unresolved = new Set<Binding>();
  for (const reset of summary.arrayResets) {
    const fact = recursiveStorageFact(state, reset, facts);
    active.arrayResets.push(fact);
    fact.outer.forEach((origin) => active.arrays.set(origin, undefined));
  }
  for (const insertion of summary.storageInsertions) {
    const binding = applyRecursiveInsertion(state, active, recursiveInsertion(state, summary, facts, insertion, point));
    if (binding) { unresolved.add(binding); }
  }
  state.factCache.clear();
  return [...unresolved];
}

function mergeSourceState(context: InvocationContext, invocation: InvocationState): void {
  const { active, stores, arrays, heapPrefix, complete, instances } = context;
  const { execution } = context.request;
  stores.push(invocation.store);
  arrays.push(invocation.arrays);
  pushHeap(active.heap, invocation.heap.slice(heapPrefix.length).map((insertion) => ({ ...insertion,
    replace: insertion.replace && complete && instances.length === 1 && execution === "once" })));
  active.storageWrites.push(...invocation.storageWrites.map((insertion) => ({ ...insertion,
    node: invocationAt(context.request.point) ?? context.request.point,
    replace: insertion.replace && complete && instances.length === 1 && execution === "once" && unconditional(context.request.point, context.request.owner) })));
  active.arrayResets.push(...invocation.arrayResets);
}

function sourceInvocation(context: InvocationContext, instance: Extract<CallableInstance, { kind: "source" }>, deferred: boolean): InvocationState {
  const { active, heapPrefix } = context;
  const { point, actuals, receiver } = context.request;
  const callContext = [...active.frame.context, point.getStart()].slice(-2);
  const frame: LexicalFrame = { id: `${ownerKey(instance.target)}>${callContext.join(">")}`, context: callContext, owner: instance.target, parent: instance.frame };
  const invocation: InvocationState = { frame, caller: invocationCaller(context), store: new Map(active.store), receiver: ts.isArrowFunction(instance.target) ? instance.receiver : receiver, actuals, phase: deferred ? "parameters" : isGenerator(instance.target) ? "body" : undefined, arrays: new Map(active.arrays), heap: [...heapPrefix], storageWrites: [], arrayResets: [], registry: active.registry, values: new Map(), calls: new Map(), stack: [...active.stack, instance.target] };
  return invocation;
}

function invocationCaller(context: InvocationContext): NonNullable<InvocationState["caller"]> {
  const { state, active } = context;
  const { point, owner, actuals, facts, execution } = context.request;
  const callableExpression = ts.isExpression(point) ? point : undefined;
  const callback = actuals.length === 0 && facts.length > 0 || !!callableExpression && parameterCallableIndex(state, callableExpression, owner) !== undefined;
  const callSite = invocationAt(point);
  return { owner, point, callback, repeated: execution === "callback" || !!active.caller?.repeated || !!callSite && repeatedCall(callSite, owner) };
}

function appendSourceReturns(context: InvocationContext, instance: Extract<CallableInstance, { kind: "source" }>, invocation: InvocationState, summary: CallableSummary, deferred: boolean): void {
  const { state, active, returns } = context;
  const { point, facts, actuals, receiver } = context.request;
  const frame = invocation.frame;
  if (deferred) {
    const origin: StorageOrigin = `private:${allocationId(point)}:iterator=${active.frame.id}`;
    const parameters = ownerParameters(instance.target).map((parameter, index) => {
      const binding = state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === parameter));
      return binding ? invocation.store.get(cellKey(frame, binding)) ?? facts[index] ?? unknownFact : facts[index] ?? unknownFact;
    });
    active.registry.set(origin, { kind: "iterator", source: instance, facts: parameters, actuals, receiver });
    returns.push({ outer: [origin], reachable: [origin] });
  } else if (isGenerator(instance.target)) {
    returns.push(...summary.yieldedAliases, ...summary.returnedAliases);
  } else {
    returns.push(...(isAsync(instance.target) ? [promiseFact(point, joinStorageFacts(summary.returnedAliases), active.frame.id)] : summary.returnedAliases));
  }
}

function evaluateAlternative(context: InvocationContext, instance: Exclude<CallableInstance, { kind: "iterator" }>): void {
  switch (instance.kind) {
    case "advance": return evaluateAdvanceAlternative(context, instance);
    case "bound": return evaluateBoundAlternative(context, instance);
    case "library": return evaluateLibraryAlternative(context, instance);
    case "source": return evaluateSourceAlternative(context, instance);
  }
}

function forceIterator(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, point: ts.Node, owner: EffectOwner,
  operation: "iterate" | "advance" = "iterate",
): CallEffects | undefined {
  const active = state.invocation;
  if (!active) { return undefined; }
  const fact = storageFactForExpression(state, summaries, expression, owner, point);
  if (operation === "advance" && heapWritesMember(state, fact, "next")) { return undefined; }
  const instances = fact.outer.flatMap((origin) => {
    const instance = invocationInstance(active, origin);
    return instance?.kind === "iterator" ? [{ origin, instance }] : [];
  });
  if (!instances.length) { return undefined; }
  const groups = instances.flatMap(({ origin, instance }) => {
    const callee = callableFact(active, instance.source.target, instance.source.frame);
    const result = evaluateInvocation(state, summaries, {
      callee,
      facts: instance.facts,
      point,
      owner,
      actuals: instance.actuals,
      receiver: instance.receiver,
      forceGenerator: true,
      execution: operation === "iterate" ? "callback" : "once",
    });
    if (result) {
      pushHeap(active.heap, [{ kind: "cell", node: point, origin: point, target: { outer: [origin], reachable: [origin] }, value: result.value, replace: false }]);
    }
    return result ? [result.effects] : [];
  });
  appendUnresolvedIteration(state, active, fact, point, owner, operation, groups);
  return combineEffects(groups);
}

function appendUnresolvedIteration(state: AnalysisState, active: InvocationState, fact: StorageFact, point: ts.Node, owner: EffectOwner, operation: "iterate" | "advance", groups: CallEffects[]): void {
  const unresolvedOrigins = fact.outer.filter((origin) => invocationInstance(active, origin)?.kind !== "iterator");
  const complete = operation === "iterate" && unresolvedOrigins.every((origin) => {
    const position = /^private:(\d+)(?::frame=.*)?$/.exec(origin)?.[1];
    return position !== undefined && state.arrayLiterals.has(Number(position)) &&
      !heapWritesMember(state, { outer: [origin], reachable: [origin] }, "Symbol.iterator");
  });
  if (unresolvedOrigins.length > 0 && !complete) {
    const unresolved = unknownEffects(point, owner, operation === "advance" ? "calls unresolved callable" : "uses unresolved iterate protocol");
    if (operation === "advance") { groups.unshift(unresolved); } else { groups.push(unresolved); }
  }
}

/** Tells if a write may have given a value its own Symbol.iterator, so iterating it may run code. */
function iterationReplaced(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, point: ts.Node, owner: EffectOwner,
): boolean {
  const fact = storageFactForExpression(state, summaries, expression, owner, point);
  const members = state.invocation?.heap.some((insertion) => insertion.target.outer.some((origin) => fact.outer.includes(origin)) &&
    (insertion.slot === "property:Symbol.iterator" || insertion.slot === undefined && !storesCollectionContents(state, insertion.origin)));
  return !!members || fact.outer.some((origin) => {
    const external = originBinding(state, origin);
    return !!external && [...state.memberWrites.get(external.binding) ?? []].some((mark) => memberWriteReaches(JSON.parse(mark) as string[], external.path));
  });
}

/** Tells if a member write at a path may reach the value a read path names, where "*" stands for any slot. */
function memberWriteReaches(written: readonly string[], read: readonly string[]): boolean {
  const deep = written[written.length - 1] === "**";
  const path = deep ? written.slice(0, -1) : written;
  return (deep ? path.length <= read.length : path.length === read.length) &&
    path.every((slot, index) => slot === read[index] || slot === "*" || read[index] === "*");
}

/** Tells if a heap write came from a library call that fills a collection, which cannot set a named member. */
function storesCollectionContents(state: AnalysisState, origin: ts.Node): boolean {
  const call = ts.isCallExpression(origin.parent) ? origin.parent
    : ts.isCallExpression(origin.parent.parent) && origin.parent.parent.expression === origin.parent ? origin.parent.parent : undefined;
  const known = call && libraryCall(call, state.model);
  return !!known && known.kind !== "effect" && known.stores !== "sources";
}

/** Tells if a value is an array literal still held, unwritten, where a module constant's initializer put it. */
function iteratesModuleArrayLiteral(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, point: ts.Node, owner: EffectOwner,
): boolean {
  const { outer } = storageFactForExpression(state, summaries, expression, owner, point);
  return outer.length > 0 && outer.every((origin) => {
    const external = originBinding(state, origin);
    const declaration = external && untouchedModuleConstant(state, external.binding);
    if (!external || !declaration) {
      return false;
    }
    const values = external.path.reduce<readonly ts.Expression[] | undefined>((held, slot) => held && literalMembers(held, slot),
      declaration.initializer ? [declaration.initializer] : undefined);
    return !!values && values.length > 0 && values.every((value) => plainArrayLiteral(unwrapExpression(value)) !== undefined);
  });
}

/** Gives the declaration of a binding that is one unexported constant nothing writes or shares. */
function untouchedModuleConstant(state: AnalysisState, binding: Binding): ts.VariableDeclaration | undefined {
  const [declaration] = binding.declarations;
  return binding.declarations.length === 1 && constantDeclaration(declaration.node) && !isExportedBinding(binding) &&
    !binding.mutated && !state.sharedBindings.has(binding) && !state.sharedLocalBindings.has(binding) ? declaration.node : undefined;
}

function literalMembers(values: readonly ts.Expression[], slot: string): readonly ts.Expression[] | undefined {
  const members = values.map((held) => {
    const value = unwrapExpression(held);
    const elements = plainArrayLiteral(value);
    if (elements) {
      const index = arrayIndexForSlot(slot);
      return slot === "*" ? elements : index !== undefined && index < elements.length ? [elements[index]] : undefined;
    }
    const properties = ts.isObjectLiteralExpression(value) && slot.startsWith("property:") ? value.properties.map((property) =>
      ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
        ? { name: property.name.text, value: property.initializer } : undefined) : [undefined];
    const named = properties.filter((property) => property?.name === slot.slice(9));
    return properties.every(Boolean) && named.length === 1 ? named.map((property) => property?.value ?? value) : undefined;
  });
  return members.every(Boolean) ? members.flatMap((member) => member ?? []) : undefined;
}

function plainArrayLiteral(value: ts.Expression): readonly ts.Expression[] | undefined {
  return ts.isArrayLiteralExpression(value) && value.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element))
    ? value.elements : undefined;
}

function joinArrayStates(state: AnalysisState, initial: ReadonlyMap<StorageOrigin, PushStart | undefined>, branches: readonly ReadonlyMap<StorageOrigin, PushStart | undefined>[]): Map<StorageOrigin, PushStart | undefined> {
  const joined = new Map(initial);
  for (const origin of new Set(branches.flatMap((branch) => [...branch.keys()]))) {
    const states = branches.map((branch) => branch.has(origin) ? branch.get(origin) : initial.has(origin) ? initial.get(origin)
      : literalAllocationLength(state, origin) === undefined ? undefined : { lowerBound: literalAllocationLength(state, origin) ?? 0, exact: true });
    const known = states.filter((start): start is PushStart => start !== undefined);
    joined.set(origin, known.length !== states.length ? undefined : {
      lowerBound: Math.min(...known.map((start) => start.lowerBound)),
      exact: known.every((start) => start.exact && start.lowerBound === known[0].lowerBound),
    });
  }
  return joined;
}

function arrayLengthValue(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, owner: EffectOwner, point: ts.Node): number | undefined {
  const value = unwrapExpression(expression);
  if (ts.isNumericLiteral(value)) { return Number(value.text); }
  if (ts.isPropertyAccessExpression(value) && value.name.text === "length") {
    return propertyArrayLength(state, summaries, value.expression, owner, point);
  }
  if (ts.isBinaryExpression(value)) {
    const left = arrayLengthValue(state, summaries, value.left, owner, point);
    const right = arrayLengthValue(state, summaries, value.right, owner, point);
    if (left !== undefined && right !== undefined) {
      if (value.operatorToken.kind === ts.SyntaxKind.PlusToken) { return left + right; }
      if (value.operatorToken.kind === ts.SyntaxKind.MinusToken) { return Math.max(0, left - right); }
    }
  }
  return undefined;
}

function propertyArrayLength(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, owner: EffectOwner, point: ts.Node): number | undefined {
  const fact = storageFactForExpression(state, summaries, expression, owner, point);
  const call = invocationAt(point);
  const start = call ? knownPushStartFromFact(state, fact, owner, call) : fact.outer.length === 1
    ? state.invocation?.arrays.has(fact.outer[0]) ? state.invocation.arrays.get(fact.outer[0])
      : (literalAllocationLength(state, fact.outer[0]) === undefined ? undefined
        : { lowerBound: literalAllocationLength(state, fact.outer[0]) ?? 0, exact: true }) : undefined;
  return start?.exact ? start.lowerBound : undefined;
}

function evaluatedSlot(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, target: ts.AccessExpression, owner: EffectOwner, point: ts.Node): string | undefined {
  const literal = storageSlot(target);
  if (literal !== undefined || !ts.isElementAccessExpression(target)) { return literal; }
  const index = arrayLengthValue(state, summaries, target.argumentExpression, owner, point);
  if (index !== undefined) { return `property:${index}`; }
  if (appendIndex(state, target)) {
    const fact = storageFactForExpression(state, summaries, target.expression, owner, point);
    const origin = fact.outer.length === 1 ? fact.outer[0] : undefined;
    const start = origin && state.invocation?.arrays.get(origin);
    if (start) { return `append:${start.lowerBound}`; }
  }
  return undefined;
}

function advanceArrayState(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Node, owner: EffectOwner): void {
  const active = state.invocation;
  if (!active) { return; }
  if (ts.isCallExpression(node) && !active.calls.has(node)) {
    advanceArrayCall(state, summaries, node, owner, active);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    advanceArrayAssignment(state, summaries, node, owner, active);
  } else if (ts.isIdentifier(node)) {
    advanceArrayMemberWrite(state, summaries, node, owner, active);
  }
}

/**
 * Moves an array's length for a member write that is not a plain assignment, as "list[1] += 1", "list[1]++",
 * "[list[1]] = [0]" or "for (list[i] of items)". A conditional write such as "??=" may leave the length alone, and a
 * loop target writes once per item, so neither keeps an exact length.
 */
function advanceArrayMemberWrite(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Identifier, owner: EffectOwner, active: InvocationState): void {
  const access = memberWriteOn(state, node);
  if (!access) { return; }
  const target = outerExpression(access);
  const fact = storageFactForExpression(state, summaries, access.expression, owner, node);
  const slot = evaluatedSlot(state, summaries, access, owner, node);
  const index = arrayIndexForSlot(slot);
  if (index === undefined || loopTarget(target)) {
    if (movesArrayLength(slot)) { setArrayLength(active, fact, undefined); }
    return;
  }
  const prior = new Map(active.arrays);
  advanceArrayIndex(state, active, fact, index);
  if (isLogicalAssignmentTarget(target)) {
    // A logical assignment may not write at all, as "&&=" on a missing index, so the length is either one.
    active.arrays = joinArrayStates(state, prior, [prior, active.arrays]);
  }
}

/** Gives the member a write through the identifier targets, unless it is a plain assignment or a delete, which keep their own length rules. */
function memberWriteOn(state: AnalysisState, node: ts.Identifier): ts.AccessExpression | undefined {
  const receiver = outerExpression(node);
  const access = receiver.parent;
  const write = writeOf(state, node);
  if (!write || write.contents || !isAccessExpression(access) || access.expression !== receiver) { return undefined; }
  const target = outerExpression(access);
  const plain = ts.isBinaryExpression(target.parent) && target.parent.left === target && target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  return plain || ts.isDeleteExpression(target.parent) ? undefined : access;
}

/** Tells if writing the slot may change an array's length: an index, the length itself, or a slot not known. */
function movesArrayLength(slot: string | undefined): boolean {
  return slot === undefined || !slot.startsWith("property:") || slot === "property:length" || arrayIndexForSlot(slot) !== undefined;
}

/** Tells if a write target sits in a for-of or for-in head, alone or inside a destructuring pattern. */
function loopTarget(target: ts.Expression): boolean {
  let current: ts.Node = target;
  while (ts.isArrayLiteralExpression(current.parent) || ts.isSpreadElement(current.parent) || ts.isPropertyAssignment(current.parent) ||
      ts.isShorthandPropertyAssignment(current.parent) || ts.isObjectLiteralExpression(current.parent)) {
    current = current.parent;
  }
  return (ts.isForOfStatement(current.parent) || ts.isForInStatement(current.parent)) && current.parent.initializer === current;
}

function isLogicalAssignmentTarget(target: ts.Expression): boolean {
  const parent = target.parent;
  return ts.isBinaryExpression(parent) && parent.left === target && [ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(parent.operatorToken.kind);
}

function advanceArrayCall(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.CallExpression, owner: EffectOwner, active: InvocationState): void {
  const known = libraryCall(node, state.model);
  const callee = unwrapExpression(node.expression);
  if (known?.kind !== "mutating" || known.target !== "receiver" ||
      (!isAccessExpression(callee))) { return; }
  const name = methodName(callee);
  if (!["push", "pop", "shift", "unshift", "splice"].includes(name ?? "")) { return; }
  const fact = storageFactForExpression(state, summaries, callee.expression, owner, node);
  if (name !== "push") { active.arrayResets.push(fact); }
  const start = knownPushStartFromFact(state, fact, owner, node);
  const delta = arrayMutationDelta(state, summaries, node, owner, name, start);
  const next = arrayLengthAfterCall(node, owner, active, start, delta);
  for (const origin of fact.outer) { active.arrays.set(origin, next); }

}

function arrayLengthAfterCall(node: ts.CallExpression, owner: EffectOwner, active: InvocationState, start: PushStart | undefined, delta: number | undefined): PushStart | undefined {
  return start && delta !== undefined && !node.arguments.some(ts.isSpreadElement) ? {
    lowerBound: Math.max(0, start.lowerBound + delta),
    exact: start.exact && !repeatedCall(node, owner) && !active.caller?.repeated,
  } : undefined;
}

function arrayMutationDelta(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.CallExpression, owner: EffectOwner, name: string | undefined, start: PushStart | undefined): number | undefined {
  const removed = node.arguments[1] && arrayLengthValue(state, summaries, node.arguments[1], owner, node);
  const offset = node.arguments[0] && arrayLengthValue(state, summaries, node.arguments[0], owner, node);
  if (name === "push" || name === "unshift") { return node.arguments.length; }
  if (name === "pop" || name === "shift") { return -1; }
  return spliceLengthDelta(name, node.arguments.length, removed, offset, start);

}

function spliceLengthDelta(name: string | undefined, argumentCount: number, removed: number | undefined, offset: number | undefined, start: PushStart | undefined): number | undefined {
  return name === "splice" && removed !== undefined && offset !== undefined && start?.exact
    ? Math.max(0, argumentCount - 2) - Math.min(removed, Math.max(0, start.lowerBound - offset)) : undefined;
}

function advanceArrayAssignment(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.BinaryExpression, owner: EffectOwner, active: InvocationState): void {
  const left = unwrapExpression(node.left);
  if (!isAccessExpression(left)) { return; }
  const slot = evaluatedSlot(state, summaries, left, owner, node);
  const fact = storageFactForExpression(state, summaries, left.expression, owner, node);
  if (slot === "property:length") {
    const length = arrayLengthValue(state, summaries, node.right, owner, node);
    setArrayLength(active, fact, length);
  } else if (slot?.startsWith("property:") && /^(0|[1-9][0-9]*)$/.test(slot.slice(9))) {
    advanceArrayIndex(state, active, fact, Number(slot.slice(9)));
  } else if (slot?.startsWith("append:")) {
    const lowerBound = Number(slot.slice(7));
    fact.outer.forEach((origin) => active.arrays.set(origin, { lowerBound, exact: false }));
  } else if (slot === undefined) {
    active.arrayResets.push(fact);
    fact.outer.forEach((origin) => active.arrays.set(origin, undefined));
  }
}

function setArrayLength(active: InvocationState, fact: StorageFact, length: number | undefined): void {
  active.arrayResets.push(fact);
  const start = length === undefined ? undefined : { lowerBound: length, exact: true };
  fact.outer.forEach((origin) => active.arrays.set(origin, start));
}

function advanceArrayIndex(state: AnalysisState, active: InvocationState, fact: StorageFact, index: number): void {
  for (const origin of fact.outer) {
    const initial = literalAllocationLength(state, origin);
    const start = active.arrays.has(origin) ? active.arrays.get(origin)
      : initial === undefined ? undefined : { lowerBound: initial, exact: true };
    active.arrays.set(origin, start ? { ...start, lowerBound: Math.max(start.lowerBound, index + 1) } : undefined);
  }
}

type SummaryDraft = {
  flows: ImplicitFlow[];
  parameterWrites: ParameterWrite[];
  deferredCalls: DeferredCall[];
  storageInsertions: StorageInsertion[];
  returnedAliases: StorageFact[];
  yieldedAliases: StorageFact[];
  returnedRuns: (CallEffects | undefined)[];
};

function literalTruth(value: ts.Expression): boolean | undefined {
  if (value.kind === ts.SyntaxKind.TrueKeyword) { return true; }
  return value.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
}

function literalNullish(value: ts.Expression, truth: boolean | undefined): boolean | undefined {
  if (value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)) { return true; }
  return truth !== undefined || ts.isLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value) ? false : undefined;
}

function shortCircuitRuns(operator: ts.SyntaxKind, truth: boolean | undefined, nullish: boolean | undefined): boolean | undefined {
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken) { return truth; }
  if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.BarBarEqualsToken) { return truth === undefined ? undefined : !truth; }
  return nullish;
}

function shortCircuitBranch(node: ts.BinaryExpression): { readonly children: readonly ts.Node[]; readonly optional: boolean } {
  const left = unwrapExpression(node.left);
  const truth = literalTruth(left);
  const runs = shortCircuitRuns(node.operatorToken.kind, truth, literalNullish(left, truth));
  return { children: runs === false ? [node.left] : [node.left, node.right], optional: runs === undefined };
}

function refineCallableBranch(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, condition: ts.Expression, truth: boolean, owner: EffectOwner): boolean {
  const active = state.invocation;
  const test = callableTypeTest(condition);
  if (!active || !test) { return true; }
  const { expression, equal } = test;
  const binding = state.model.resolve(expression);
  const frame = binding && frameForBinding(state, binding);
  if (!binding || !frame) { return true; }
  const fact = storageFactForBinding(state, summaries, binding, owner, condition);
  const callable = truth === equal;
  const outer = fact.outer.filter((origin) => callableOriginPossible(state, active, origin, callable));
  const removed = new Set(fact.outer.filter((origin) => !outer.includes(origin)));
  active.store.set(cellKey(frame, binding), { outer, reachable: fact.reachable.filter((origin) => !removed.has(origin)),
    cells: fact.cells?.filter((cell) => !removed.has(cell.allocation)) });
  return outer.length > 0;
}

function callableTypeTest(condition: ts.Expression): { readonly expression: ts.Identifier; readonly equal: boolean } | undefined {
  const comparison = unwrapExpression(condition);
  if (!ts.isBinaryExpression(comparison)) { return undefined; }
  const operator = comparison.operatorToken.kind;
  const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
  if (!equal && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsToken) { return undefined; }
  const expression = functionTypeOperand(unwrapExpression(comparison.left), unwrapExpression(comparison.right));
  return expression ? { expression, equal } : undefined;
}

function functionTypeOperand(left: ts.Expression, right: ts.Expression): ts.Identifier | undefined {
  const type = ts.isTypeOfExpression(left) ? left : ts.isTypeOfExpression(right) ? right : undefined;
  const literal = type === left ? right : left;
  if (!type || !ts.isStringLiteral(literal) || literal.text !== "function") { return undefined; }
  const expression = unwrapExpression(type.expression);
  return ts.isIdentifier(expression) ? expression : undefined;
}

function callableOriginPossible(state: AnalysisState, active: InvocationState, origin: StorageOrigin, callable: boolean): boolean {
  const instance = invocationInstance(active, origin);
  if (instance) { return callable === (instance.kind !== "iterator"); }
  const position = /^private:(\d+)(?::frame=.*)?$/.exec(origin)?.[1];
  const nonCallable = position !== undefined && (state.arrayLiterals.has(Number(position)) || state.objectLiterals.has(Number(position)));
  return !callable || !nonCallable;
}

function hasInvocation(state: AnalysisState): state is AnalysisState & { readonly invocation: InvocationState } {
  return state.invocation !== undefined;
}

function summarizeCallable(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  owner: EffectOwner,
  includeThis: boolean,
): CallableSummary {
  if (!hasInvocation(state)) {
    const frame = { id: ownerKey(owner), context: [], owner };
    const store = new Map<string, StorageFact>();
    for (const binding of state.model.bindings.filter((item) => isParameterOf(item, owner))) {
      store.set(cellKey(frame, binding), storageFactAt(state.model, binding, owner, owner));
    }
    const invocation: InvocationState = { frame, store, arrays: new Map(), heap: [], storageWrites: [], arrayResets: [], registry: state.callableRegistry, values: new Map(), calls: new Map(), stack: [owner] };
    const summary = summarizeCallable({ ...state, invocation, factCache: new Map(), insertionCache: new Map() }, summaries, owner, includeThis);
    return { ...summary, storageInsertions: uniqueInsertions(invocation.storageWrites), arrayResets: uniqueFacts(invocation.arrayResets) };
  }
  const draft: SummaryDraft = {
    flows: [], parameterWrites: [], deferredCalls: [], storageInsertions: [], returnedAliases: [], yieldedAliases: [],
    returnedRuns: [],
  };
  const context: SummaryContext = { state, summaries, owner, includeThis, draft, visit };
  function visit(node: ts.Node): void {
    if (visitDeferredNode(context, node)) { return; }
    recordThrowPoint(context.state.invocation, node);
    const iterationEffects = visitExecutedChildren(context, node);
    recordExecutedNode(context, node, iterationEffects);
    if (ts.isBreakOrContinueStatement(node)) { recordJump(context.state.invocation, node); }
  }
  executionRoots(owner).forEach(visit);
  appendEffects(draft, inheritedConstructorEffects(state, summaries, owner));
  return {
    owner,
    flows: uniqueSummaryFlows(draft.flows),
    parameterWrites: uniqueWrites(draft.parameterWrites),
    deferredCalls: uniqueDeferredCalls(draft.deferredCalls),
    storageInsertions: uniqueInsertions(draft.storageInsertions),
    arrayResets: uniqueFacts(state.invocation.arrayResets),
    returnedAliases: uniqueFacts(draft.returnedAliases),
    yieldedAliases: uniqueFacts(draft.yieldedAliases),
    returnedRuns: draft.returnedRuns.length > 0 && draft.returnedRuns.every((runs) => runs !== undefined)
      ? combineEffects(draft.returnedRuns) : undefined,
  };
}

type SummaryContext = {
  readonly state: AnalysisState & { readonly invocation: InvocationState };
  readonly summaries: ReadonlyMap<EffectOwner, CallableSummary>;
  readonly owner: EffectOwner;
  readonly includeThis: boolean;
  readonly draft: SummaryDraft;
  readonly visit: (node: ts.Node) => void;
};

function visitDeferredNode(context: SummaryContext, node: ts.Node): boolean {
  const { state, summaries, owner, draft, visit } = context;
  if (state.invocation.phase === "parameters" && node === owner) {
    ownerParameters(owner).forEach(visit);
    return true;
  }
  if (ts.isParameter(node) && visitParameter(context, node)) { return true; }
  const deferred = deferredChildren(node, owner);
  if (deferred !== undefined) {
    deferred.forEach(visit);
    const returned = returnedExpression(node, owner);
    if (returned) { appendReturn(state, summaries, draft, returned, owner); }
    return true;
  }
  return false;
}

/** Visits a parameter where the invocation decides whether its default runs, and tells if it did. */
function visitParameter(context: SummaryContext, node: ts.ParameterDeclaration): boolean {
  const { invocation } = context.state;
  if (invocation.phase === "body") { return true; }
  if (invocation.actuals) {
    visitSuppliedParameter(context, node, invocation.actuals);
    return true;
  }
  if (node.initializer && ts.isIdentifier(node.name)) {
    visitDefaultParameter(context, node, node.initializer);
    return true;
  }
  return false;
}

function parameterBinding(state: AnalysisState, node: ts.ParameterDeclaration): Binding | undefined {
  return state.model.bindings.find((item) => item.declarations.some((declaration) => declaration.node === node));
}

function suppliedDefaultMayRun(context: SummaryContext, node: ts.ParameterDeclaration, actuals: readonly ts.Expression[], index: number): boolean {
  const { state } = context;
  const binding = parameterBinding(state, node);
  const supplied = binding && state.invocation.store.get(cellKey(state.invocation.frame, binding));
  const knownObject = supplied && supplied.outer.length > 0 && supplied.outer.every((origin) => origin.startsWith("private:"));
  return !knownObject && defaultMayRun(index, actuals, state.model);
}

function missingArgument(actual: ts.Expression | undefined, model: ScopeModel): boolean {
  return !actual || (ts.isIdentifier(unwrapExpression(actual)) && globalName(actual, model) === "undefined");
}

function visitSuppliedParameter(context: SummaryContext, node: ts.ParameterDeclaration, actuals: readonly ts.Expression[]): void {
  const { state, summaries, owner, visit } = context;
  const index = ownerParameters(owner).indexOf(node);
  if (!node.initializer || !suppliedDefaultMayRun(context, node, actuals, index)) { return; }
  visit(node.initializer);
  const binding = parameterBinding(state, node);
  if (binding) {
    const value = storageFactForExpression(state, summaries, node.initializer, owner, node);
    const key = cellKey(state.invocation.frame, binding);
    state.invocation.store.set(key, missingArgument(actuals[index], state.model) ? value : joinStorageFacts([state.invocation.store.get(key) ?? unknownFact, value]));
  }
}

/** Lets a parameter whose default creates a generator also hold that generator, so enumerating the parameter runs its body. */
function visitDefaultParameter(context: SummaryContext, node: ts.ParameterDeclaration, initializer: ts.Expression): void {
  const { state, summaries, owner, visit } = context;
  visit(node.name);
  visit(initializer);
  const binding = parameterBinding(state, node);
  const created = storageFactForExpression(state, summaries, initializer, owner, node);
  if (binding && created.outer.length > 0 && created.outer.every((origin) => invocationInstance(state.invocation, origin)?.kind === "iterator")) {
    const supplied = storageFactForExpression(state, summaries, node.name as ts.Identifier, owner, node);
    state.invocation.store.set(cellKey(state.invocation.frame, binding), joinStorageFacts([supplied, created]));
  }
}

function nodeCondition(node: ts.Node): ts.Expression | undefined {
  if (ts.isIfStatement(node)) { return node.expression; }
  return ts.isConditionalExpression(node) ? node.condition : undefined;
}

function executionBranches(node: ts.Node): { readonly reachable?: readonly ts.Node[]; readonly condition?: ts.Expression; readonly split: boolean } {
  const shortCircuit = ts.isBinaryExpression(node) && isShortCircuit(node.operatorToken.kind) ? shortCircuitBranch(node) : undefined;
  const condition = nodeCondition(node);
  const conditionalSplit = condition !== undefined && literalTruth(unwrapExpression(condition)) === undefined;
  return { reachable: reachableChildren(node) ?? shortCircuit?.children, condition, split: !!shortCircuit?.optional || conditionalSplit };
}

function visitExecutedChildren(context: SummaryContext, node: ts.Node): CallEffects | undefined {
  const { visit } = context;
  const { reachable, condition, split } = executionBranches(node);
  if (ts.isSwitchStatement(node)) {
    visitSwitch(context, node);
  } else if (ts.isTryStatement(node)) {
    visitTry(context, node);
  } else if (ts.isLabeledStatement(node)) {
    visit(node.statement);
    joinFlows(context.state, takeJumps(context.state.invocation, node, "break"));
  } else if (reachable && split) {
    visitConditional(context, reachable, condition);
  } else if (ts.isIterationStatement(node, false) && !reachable) {
    return visitLoop(context, node);
  } else if (reachable) {
    reachable.forEach(visit);
  } else {
    ts.forEachChild(node, visit);
  }
  return undefined;
}

function visitSwitch(context: SummaryContext, node: ts.SwitchStatement): void {
  const { state, visit } = context;
  visit(node.expression);
  const active = state.invocation;
  const initial = new Map(active.store);
  const heap = [...active.heap];
  const initialArrays = new Map(active.arrays);
  const branchArrays: Map<StorageOrigin, PushStart | undefined>[] = [];
  const values = new Map(active.values);
  const calls = new Map(active.calls);
  const clauses = node.caseBlock.clauses;
  const stores: Map<string, StorageFact>[] = clauses.some(ts.isDefaultClause) ? [] : [initial];
  const heaps: StorageInsertion[][] = clauses.some(ts.isDefaultClause) ? [] : [heap];
  for (let start = 0; start < clauses.length; start++) {
    active.store = new Map(initial);
    active.heap = [...heap];
    active.arrays = new Map(initialArrays);
    active.values.clear();
    values.forEach((value, key) => active.values.set(key, value));
    active.calls.clear();
    calls.forEach((value, key) => active.calls.set(key, value));
    state.factCache.clear();
    state.insertionCache.clear();
    visitSwitchPath(context, clauses.slice(start));
    stores.push(new Map(active.store));
    branchArrays.push(new Map(active.arrays));
    heaps.push([...active.heap]);
  }
  active.store = joinBindingStores(initial, stores);
  active.heap = joinInvocationHeaps(heap, heaps);
  active.arrays = joinArrayStates(state, initialArrays, clauses.some(ts.isDefaultClause) ? branchArrays : [initialArrays, ...branchArrays]);
  active.values.clear();
  values.forEach((value, key) => active.values.set(key, value));
  active.calls.clear();
  calls.forEach((value, key) => active.calls.set(key, value));
  joinFlows(state, takeJumps(active, node, "break"));
}

function visitSwitchPath(context: SummaryContext, clauses: readonly ts.CaseOrDefaultClause[]): void {
  const { visit } = context;
  for (const clause of clauses) {
    if (ts.isCaseClause(clause)) { visit(clause.expression); }
    for (const statement of clause.statements) {
      if (ts.isBreakStatement(statement) && !statement.label) { return; }
      visit(statement);
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakOrContinueStatement(statement)) { return; }
    }
  }
}

function visitConditional(context: SummaryContext, reachable: readonly ts.Node[], condition: ts.Expression | undefined): void {
  const { state, summaries, owner, visit } = context;
  visit(reachable[0]);
  const initial = new Map(state.invocation.store);
  const heap = [...state.invocation.heap];
  const initialArrays = new Map(state.invocation.arrays);
  const branchArrays: Map<StorageOrigin, PushStart | undefined>[] = [];
  const values = new Map(state.invocation.values);
  const calls = new Map(state.invocation.calls);
  const branches: Map<string, StorageFact>[] = reachable.length === 2 ? [initial] : [];
  const heaps: StorageInsertion[][] = reachable.length === 2 ? [heap] : [];
  for (const [branchIndex, branch] of reachable.slice(1).entries()) {
    state.invocation.store = new Map(initial);
    state.invocation.heap = [...heap];
    state.invocation.arrays = new Map(initialArrays);
    state.invocation.values.clear();
    values.forEach((value, key) => state.invocation?.values.set(key, value));
    state.invocation.calls.clear();
    calls.forEach((value, key) => state.invocation?.calls.set(key, value));
    state.factCache.clear();
    state.insertionCache.clear();
    if (!condition || refineCallableBranch(state, summaries, condition, branchIndex === 0, owner)) { visit(branch); }
    branches.push(new Map(state.invocation.store));
    branchArrays.push(new Map(state.invocation.arrays));
    heaps.push([...state.invocation.heap]);
  }
  state.invocation.store = joinBindingStores(initial, branches);
  state.invocation.heap = joinInvocationHeaps(heap, heaps);
  state.invocation.arrays = joinArrayStates(state, initialArrays, reachable.length === 2 ? [initialArrays, ...branchArrays] : branchArrays);
}

function visitLoop(context: SummaryContext, node: ts.IterationStatement): CallEffects | undefined {
  const { state } = context;
  const initial = new Map(state.invocation.store);
  const heap = [...state.invocation.heap];
  const initialArrays = new Map(state.invocation.arrays);
  const iterationEffects = visitInitialLoop(context, node);
  joinFlows(state, takeJumps(state.invocation, node, "continue"));
  state.invocation.arrays = joinArrayStates(state, initialArrays, [initialArrays, state.invocation.arrays]);
  state.invocation.store = joinBindingStores(initial, [initial, state.invocation.store]);
  state.invocation.heap = joinInvocationHeaps([], [heap, state.invocation.heap]);
  let previous: string;
  do {
    const active = state.invocation;
    previous = invocationStateKey(active);
    const store = new Map(active.store);
    const heap = [...active.heap];
    const arrays = new Map(active.arrays);
    for (const expression of active.values.keys()) {
      if (repeatedPartOfIteration(expression, node)) { active.values.delete(expression); }
    }
    for (const call of active.calls.keys()) {
      if (repeatedPartOfIteration(call, node)) { active.calls.delete(call); }
    }
    state.factCache.clear();
    state.insertionCache.clear();
    visitRepeatedLoop(context, node);
    joinFlows(state, takeJumps(active, node, "continue"));
    active.store = joinBindingStores(store, [store, active.store]);
    active.heap = joinInvocationHeaps([], [heap, active.heap]);
    active.arrays = joinArrayStates(state, arrays, [arrays, active.arrays]);
  } while (invocationStateKey(state.invocation) !== previous);
  joinFlows(state, takeJumps(state.invocation, node, "break"));
  return iterationEffects;
}

function captureFlow(active: InvocationState): FlowState {
  return { store: new Map(active.store), heap: [...active.heap], arrays: new Map(active.arrays) };
}

/** The statement a break or continue leaves: its label, or the closest loop or switch. A continue to a label repeats the labeled loop. */
function jumpTarget(node: ts.BreakOrContinueStatement): ts.Node | undefined {
  for (let current = node.parent; !endsJumpSearch(current); current = current.parent) {
    if (node.label && ts.isLabeledStatement(current) && current.label.text === node.label.text) {
      return ts.isBreakStatement(node) ? current : current.statement;
    }
    if (!node.label && unlabeledJumpLands(node, current)) {
      return current;
    }
  }
  return undefined;
}

function unlabeledJumpLands(node: ts.BreakOrContinueStatement, current: ts.Node): boolean {
  return ts.isIterationStatement(current, false) || (ts.isBreakStatement(node) && ts.isSwitchStatement(current));
}

function endsJumpSearch(node: ts.Node): boolean {
  return isFunctionLike(node) || ts.isClassLike(node) || ts.isClassStaticBlockDeclaration(node) || ts.isSourceFile(node);
}

function recordJump(active: InvocationState, node: ts.BreakOrContinueStatement): void {
  const target = jumpTarget(node);
  if (target) { (active.jumps ??= []).push({ ...captureFlow(active), target, kind: ts.isBreakStatement(node) ? "break" : "continue" }); }
}

function takeJumps(active: InvocationState, target: ts.Node, kind: Jump["kind"]): readonly FlowState[] {
  const taken = active.jumps?.filter((jump) => jump.target === target && jump.kind === kind) ?? [];
  if (taken.length > 0) { active.jumps = active.jumps?.filter((jump) => !taken.includes(jump)); }
  return taken;
}

/** Saves the state before each statement of a try block, since an exception there reaches the handler with that state. */
function recordThrowPoint(active: InvocationState, node: ts.Node): void {
  const handlers = active.handlers;
  if (handlers && handlers.length > 0 && ts.isStatement(node)) { handlers[handlers.length - 1].push(captureFlow(active)); }
}

/** Joins other paths into the current state, keeping the heap writes that every path shares as a common prefix. */
function joinFlows(state: AnalysisState & { readonly invocation: InvocationState }, others: readonly FlowState[]): void {
  if (others.length === 0) { return; }
  const active = state.invocation;
  const flows = [captureFlow(active), ...others];
  const first = flows[0].heap;
  let prefix = 0;
  while (prefix < first.length && flows.every((flow) => flow.heap[prefix] === first[prefix])) { prefix += 1; }
  active.store = joinBindingStores(active.store, flows.map((flow) => flow.store));
  active.heap = joinInvocationHeaps(first.slice(0, prefix), flows.map((flow) => flow.heap));
  active.arrays = joinArrayStates(state, active.arrays, flows.map((flow) => flow.arrays));
  state.factCache.clear();
  state.insertionCache.clear();
}

/**
 * Walks a try statement. The handler starts from any state the try block could throw in, the finally block from any
 * state that reaches it, and the code after it from the joined end of the try and the handler.
 */
function visitTry(context: SummaryContext, node: ts.TryStatement): void {
  const { state, visit } = context;
  const active = state.invocation;
  const handlers = active.handlers ??= [];
  handlers.push([captureFlow(active)]);
  visit(node.tryBlock);
  let escaped = handlers.pop() ?? [];
  if (node.catchClause) {
    const normal = captureFlow(active);
    joinFlows(state, escaped);
    if (node.finallyBlock) { handlers.push([captureFlow(active)]); }
    visit(node.catchClause);
    escaped = node.finallyBlock ? handlers.pop() ?? [] : [];
    joinFlows(state, [normal]);
  }
  if (node.finallyBlock) {
    joinFlows(state, escaped);
    visit(node.finallyBlock);
  }
}

function bindIterationValues(context: SummaryContext, node: ts.ForOfStatement): void {
  const { state, summaries, owner } = context;
  const fact = storageFactForExpression(state, summaries, node.expression, owner, node);
  for (const [binding, assignment] of assignedAt(state, "iterated", node.statement)) {
    const frame = frameForBinding(state, binding);
    if (frame) {
      state.invocation.store.set(cellKey(frame, binding), selectedFact(fact, assignment,
        (expression) => storageFactForExpression(state, summaries, expression, owner, node)));
    }
  }
  state.factCache.clear();
}

function visitInitialLoop(context: SummaryContext, node: ts.IterationStatement): CallEffects | undefined {
  const { state, summaries, owner, visit } = context;
  let iterationEffects: CallEffects | undefined;
  if (ts.isForOfStatement(node)) {
    visit(node.expression);
    iterationEffects = evaluationEffects(state, summaries, node, owner);
    state.factCache.clear();
    visit(node.initializer);
    bindIterationValues(context, node);
    visit(node.statement);
  } else {
    ts.forEachChild(node, visit);
  }
  return iterationEffects;
}

function visitRepeatedLoop(context: SummaryContext, node: ts.IterationStatement): void {
  const { visit } = context;
  if (ts.isForStatement(node)) {
    if (node.condition) { visit(node.condition); }
    visit(node.statement);
    if (node.incrementor) { visit(node.incrementor); }
  } else if (ts.isWhileStatement(node)) {
    visit(node.expression);
    visit(node.statement);
  } else {
    if (ts.isForOfStatement(node)) {
      bindIterationValues(context, node);
    }
    visit(node.statement);
    if (ts.isDoStatement(node)) { visit(node.expression); }
  }
}

function recordExecutedNode(context: SummaryContext, node: ts.Node, iterationEffects?: CallEffects): void {
  const { state, summaries, owner, includeThis, draft } = context;
  invocationEvent(state, summaries, node, owner);
  const heapSize = heapLength(state);
  appendEffects(draft, nodeEffects(state, summaries, node, owner, includeThis, iterationEffects), defaultParameterIndexFor(node, owner));
  recacheIteratedValue(state, summaries, node, owner, heapSize);
  if (ts.isYieldExpression(node) && node.expression && !node.asteriskToken) {
    draft.yieldedAliases.push(storageFactForExpression(state, summaries, node.expression, owner, node));
  }
  const returned = returnedExpression(node, owner);
  if (returned) {
    appendReturn(state, summaries, draft, returned, owner);
  }
  const insertions = isInvocation(node) && state.invocation?.calls.has(node)
    ? [] : storageInsertionsForNode(state, summaries, node, owner);
  draft.storageInsertions.push(...insertions);
  state.invocation.storageWrites.push(...insertions);
  pushHeap(state.invocation.heap, insertions.filter((insertion) => insertion.kind === "cell"));
  advanceArrayState(state, summaries, node, owner);
  state.factCache.clear();
}

function heapLength(state: AnalysisState): number {
  return state.invocation?.heap.length ?? 0;
}

/**
 * Caches a node's value again once running the node stored something new, as when "new Map(gen())" runs the generator and
 * holds what it yielded. The value cached before the node ran cannot see that storage.
 */
function recacheIteratedValue(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.Node, owner: EffectOwner, heapSize: number): void {
  const active = state.invocation;
  if (active && ts.isExpression(node) && active.values.has(node) && active.heap.slice(heapSize).some((insertion) => insertion.node === node)) {
    active.values.delete(node);
    state.factCache.clear();
    state.insertionCache.clear();
    cacheInvocationValue(state, summaries, node, owner, active);
  }
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
    if (isAccessExpression(target)) {
      return [{ kind: "cell", node, origin: node, target: storageFactForExpression(state, summaries, target.expression, owner, node),
        value: storageFactForExpression(state, summaries, node.right, owner, node),
        slot: evaluatedSlot(state, summaries, target, owner, node), replace: state.invocation !== undefined || unconditional(node, owner) }];
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
    const callbacks = (summary?.deferredCalls ?? []).flatMap((parameterCall) => {
      if (parameterCall.callee.kind !== "parameter" || parameterCall.owner !== target) { return []; }
      const callback = args[parameterCall.callee.parameterIndex];
      if (!callback) {
        return [];
      }
      const targets = resolveTargets(dispatchFor(state, summaries), callback);
      const facts = parameterCall.argumentOwner === target
        ? parameterCall.argumentFacts.map((fact) => invocationStorageFact(state, summaries, fact, invocation, owner)) : parameterCall.argumentFacts;
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
  const target = invocationStorageFact(state, summaries, calleeOwnCellsRemoved(insertion.target), invocation, owner);
  const slot = transferredInsertionSlot(state, insertion, target, invocation, sourceOwner, node, owner, repeated);
  return { ...insertion, node, target, value: invocationStorageFact(state, summaries, insertion.value, invocation, owner), slot,
    replace: mayReplace && (insertion.appendCall ? slot !== undefined && !slot.startsWith("append:") : insertion.replace) };
}

function calleeOwnCellsRemoved(fact: StorageFact): StorageFact {
  return fact.cells ? { ...fact, cells: fact.cells.filter((cell) => !parameterProjection(cell.allocation)) } : fact;
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
      replace: part.slot !== undefined && !part.slot.startsWith("append:") && !isWildcardSlot(part.slot) && unconditional(call, owner) };
  })];
}

function libraryStoredArguments(
  state: AnalysisState, call: ts.CallExpression, owner: EffectOwner,
  stores: LibraryStorage, args: readonly ts.Expression[],
): StoredArgument[] {
  const parts = storedArguments(call, args, stores);
  const callee = unwrapExpression(call.expression);
  if (stores !== "arguments" || methodName(callee) !== "push" ||
      (!isAccessExpression(callee))) {
    return parts;
  }
  const start = knownPushStart(state, callee.expression, owner, call);
  if (!start) {
    return parts;
  }
  const appendRange = pushUsesRange(state, call, owner, start, args);
  return parts.map((part, index) => ({ ...part,
    slot: appendRange ? `append:${start.lowerBound}` : `property:${start.lowerBound + index}`,
  }));
}

function pushUsesRange(state: AnalysisState, call: ts.CallExpression, owner: EffectOwner, start: PushStart, args: readonly ts.Expression[]): boolean {
  return !start.exact || !!state.invocation?.caller?.repeated || repeatedCall(call, owner) || args.some(ts.isSpreadElement);
}

type StoredArgument = { readonly expression: ts.Expression; readonly path: StoragePath; readonly slot?: string };

function storedArguments(call: ts.CallExpression, args: readonly ts.Expression[], stores: LibraryStorage): StoredArgument[] {
  if (stores === "entry") {
    const key = call.arguments[0] && literalStorageKey(call.arguments[0]);
    const [first, ...values] = call.arguments;
    return [...first && key === undefined ? [{ expression: first, path: "outer" as const, slot: KEY_SLOT }] : [],
      ...values.map((expression) => ({ expression, path: "outer" as const, slot: key === undefined ? undefined : `entry:${key}` }))];
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
  draft.deferredCalls.push(...effects.deferredCalls.map((call) => ({ ...call, defaultParameterIndex: defaultParameterIndex ?? call.defaultParameterIndex })));
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
  iterationEffects?: CallEffects,
): CallEffects {
  const receiverCall = ts.isIdentifier(node) ? methodCallOn(node) : undefined;
  const deferredMutation = receiverCall && writeOf(state, node)?.contents && libraryCall(receiverCall, state.model)?.kind === "mutating";
  const mutation = deferredMutation ? { flows: [], writes: [] } : mutationEffectsFor(state, summaries, node, owner);
  const direct = deferredMutation ? [] : directFlowsFor(state, node, owner, includeThis);
  const directEffects = directReceiverEffects(state, direct, node, owner);
  return combineEffects([
    directEffects,
    { ...mutation, deferredCalls: [] },
    ...writeTargets(node).map((target) => computedWriteEffects(state, summaries, target, node, owner)),
    invocationEffects(state, summaries, node, owner),
    iterationEffects ?? evaluationEffects(state, summaries, node, owner),
  ]);
}

function directReceiverEffects(state: AnalysisState, direct: ImplicitFlow[], node: ts.Node, owner: EffectOwner): CallEffects {
  const receiver = state.invocation?.receiver;
  return receiver
    ? combineEffects(direct.map((flow) => flow.receiver ? receiverFlow(state, flow, receiver, node, owner)
      : { flows: [flow], writes: [], deferredCalls: [] }))
    : { flows: direct, writes: [], deferredCalls: [] };
}

function invocationEffects(
  state: AnalysisState,
  summaries: ReadonlyMap<EffectOwner, CallableSummary>,
  node: ts.Node,
  owner: EffectOwner,
): CallEffects {
  if (ts.isCallExpression(node)) {
    return callReadEffects(state, summaries, node, owner);
  }
  if (ts.isNewExpression(node)) {
    return constructorEffects(state, summaries, node.expression, node.arguments ?? [], node.expression, owner);
  }
  if (isAccessExpression(node)) {
    return accessorEffects(state, summaries, node, owner);
  }
  const setter = assignedAccessor(node);
  if (setter) { return accessorKindEffects(state, summaries, setter, owner, "set"); }
  return ts.isTaggedTemplateExpression(node) ? taggedTemplateEffects(state, summaries, node, owner) : emptyCallEffects();
}

function callReadEffects(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, node: ts.CallExpression, owner: EffectOwner): CallEffects {
  const effects = callEffects(state, summaries, node, owner);
  const result = state.invocation?.calls.get(node)?.value;
  const read = result && externalReads(state, result, storageReadSites(state, node), owner, false);
  return read ? combineEffects([effects, { flows: [{ kind: "input", node, owner, binding: read, access: "read", description: `reads ${read.name}` }], writes: [], deferredCalls: [] }]) : effects;
}

function assignedAccessor(node: ts.Node): ts.AccessExpression | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
    const left = unwrapExpression(node.left);
    if (isAccessExpression(left)) {
      return left;
    }
  }
  if (isIncrement(node) && (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))) {
    const operand = unwrapExpression(node.operand);
    if (isAccessExpression(operand)) {
      return operand;
    }
  }
  return undefined;
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
  if (ts.isDecorator(node)) { return unknownEffects(node, owner, "uses unresolved decorator application"); }
  const dispatch = dispatchFor(state, summaries);
  const hooked = convertedValues(node, state.model).some(({ expression, hooks }) => knownShapeHasMember(dispatch, expression, hooks));
  return combineEffects([hooked ? unknownEffects(node, owner, "uses unresolved convert protocol") : emptyCallEffects(),
    ...protocolExpressions(node, state.model).map(({ expression, protocol }) => {
    const iterated = protocol === "iterate" ? knownIterationEffects(state, summaries, expression, node, owner) : undefined;
    if (iterated) { return iterated; }
    if (protocol === "await" && awaitHasNoEffects(state, summaries, expression, node, owner)) { return emptyCallEffects(); }
    return supportsProtocol(state.model, expression, protocol) ? emptyCallEffects()
      : unknownEffects(node, owner, `uses unresolved ${protocol} protocol`);
  })]);
}

/** Gives the effects of enumerating a value whose iteration the analysis knows. */
function knownIterationEffects(
  state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, node: ts.Node, owner: EffectOwner,
): CallEffects | undefined {
  const forced = forceIterator(state, summaries, expression, node, owner);
  if (forced) { return forced; }
  if (iterationReplaced(state, summaries, expression, node, owner)) { return unknownEffects(node, owner, "uses unresolved iterate protocol"); }
  const shared = sharedGeneratorEffects(state, summaries, expression, node, owner);
  if (shared) { return shared; }
  const known = isKnownIterator(state, summaries, expression) || iteratesModuleArrayLiteral(state, summaries, expression, node, owner);
  return known ? emptyCallEffects() : undefined;
}

function awaitHasNoEffects(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, expression: ts.Expression, node: ts.Node, owner: EffectOwner): boolean {
  if (isHotAsyncCall(state, summaries, expression)) { return true; }
  const fact = storageFactForExpression(state, summaries, expression, owner, node);
  return fact.outer.length > 0 && fact.outer.every((origin) => state.invocation?.registry.get(origin)?.kind === "iterator") &&
    !heapWritesMember(state, fact, "then");
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

function runtimeTypeChildren(node: ts.Node): readonly ts.Expression[] {
  if (!ts.isExpressionWithTypeArguments(node)) { return []; }
  const parent = node.parent;
  if (!ts.isHeritageClause(parent)) { return [node.expression]; }
  return parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(parent.parent)
    ? [node.expression] : [];
}

function deferredChildren(node: ts.Node, owner: EffectOwner): readonly ts.Node[] | undefined {
  if (ts.isTypeNode(node)) { return runtimeTypeChildren(node); }
  if (ts.isExportDeclaration(node)) { return []; }
  if (ts.isParameter(node)) { return [node.name, ...(node.initializer ? [node.initializer] : [])]; }
  if (isFunctionLike(node)) {
    return node === owner ? [...node.parameters, ...(node.body ? [node.body] : [])] : definitionExpressions(node);
  }
  return isInstanceField(node) ? definitionExpressions(node) : undefined;
}

function definitionExpressions(node: ts.Node): readonly ts.Node[] {
  const computed = (isFunctionLike(node) || ts.isPropertyDeclaration(node)) && node.name && ts.isComputedPropertyName(node.name)
    ? [node.name.expression] : [];
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  const parameters = isFunctionLike(node) ? node.parameters.flatMap((parameter) => ts.getDecorators(parameter) ?? []) : [];
  return [...computed, ...decorators, ...parameters];
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
  const unknown = !parents.complete ? [unknownEffects(base, owner, "constructs unresolved base class")] : [];
  if (parents.targets.length === 0 && isPureConstructor(globalName(base, state.model))) { return emptyCallEffects(); }
  return combineEffects([...unknown, ...parents.targets.map((parent) => {
    const summary = summaries.get(explicitConstructor(parent) ?? parent);
    return summary ? {
      flows: summary.flows.flatMap((flow) => reboundFlow(state, summaries, flow, base, owner, privateFact).flows
        .map((rebound) => ({ ...rebound, defaultParameterIndex: flow.defaultParameterIndex }))),
      writes: summary.parameterWrites.map((write) => ({ ...write, node: base })),
      deferredCalls: summary.deferredCalls.map((call) => ({ ...call, node: base,
        owner: call.owner === summary.owner ? owner : call.owner,
        argumentOwner: call.argumentOwner === summary.owner ? owner : call.argumentOwner })),
    } : unknownEffects(base, owner, "constructs unresolved base class");
  })]);
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
  const facts = returnedStorageFactsForExpression(state, summaries, expression, owner);
  draft.returnedAliases.push(...facts);
  escapeReturnedStorage(state, facts, expression, owner);
  draft.returnedRuns.push(iteratorRuns(state, summaries, expression, owner, new Set()));
}

function uniqueFlows(flows: readonly ImplicitFlow[]): readonly ImplicitFlow[] {
  return deduplicateFlows(flows, (flow) => `${ownerKey(flow.owner)}:${flow.kind}:${flow.description}`);
}

function deduplicateFlows(flows: readonly ImplicitFlow[], keyFor: (flow: ImplicitFlow) => string): ImplicitFlow[] {
  const first = new Map<string, ImplicitFlow>();
  for (const flow of flows) {
    const key = keyFor(flow);
    const previous = first.get(key);
    if (!previous || flow.kind === "unknown" && (flow.node.getStart() < previous.node.getStart() ||
        flow.node.getStart() === previous.node.getStart() && flow.node.end > previous.node.end)) {
      first.set(key, flow);
    }
  }
  return flows.filter((flow) => first.get(keyFor(flow)) === flow);
}

function uniqueSummaryFlows(flows: readonly ImplicitFlow[]): readonly ImplicitFlow[] {
  const seen = new Set<string>();
  const inputs = new Set<string>();
  const ids = new Map<object, number>();
  return flows.filter((flow) => {
    const site = flow.access === "contents" || flow.kind === "input" ? `${flow.node.getStart()}:${flow.writeNode?.getStart()}` : "";
    const key = `${ownerKey(flow.owner)}:${flow.kind}:${flow.description}:${site}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    if (flow.kind !== "input") {
      return true;
    }
    // A read keeps the forwarded write only as provenance, so reads that differ in nothing else are one read.
    const content = inputFlowContent(flow, ids);
    if (inputs.has(content)) {
      return false;
    }
    inputs.add(content);
    return true;
  });
}

function flowObjectId(ids: Map<object, number>, item: object | undefined): number | undefined {
  if (!item) { return undefined; }
  const known = ids.get(item);
  if (known !== undefined) { return known; }
  const id = ids.size + 1;
  ids.set(item, id);
  return id;
}

function inputFlowContent(flow: ImplicitFlow, ids: Map<object, number>): string {
  return JSON.stringify([flowObjectId(ids, flow.owner), flow.kind, flow.description, flowObjectId(ids, flow.node), flowObjectId(ids, flow.binding),
    flow.access, flow.path, flow.receiver, flow.defaultParameterIndex, flow.parameterIndex, flow.origins, flow.argumentWrite,
    flow.readParameterIndex, flow.reads]);
}

function uniqueWrites(writes: readonly ParameterWrite[]): readonly ParameterWrite[] {
  const seen = new Set<string>();
  return writes.filter((write) => {
    const key = `${write.parameterIndex}:${write.path}:${write.description}:${write.node.getStart()}:${write.writeNode?.getStart()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deferredCallableKey(callee: DeferredCallable): string {
  return callee.kind === "parameter" ? `parameter:${callee.parameterIndex}` : `capture:${externalBindingOrigin(callee.binding)}`;
}

function uniqueDeferredCalls(calls: readonly DeferredCall[]): readonly DeferredCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${ownerKey(call.owner)}:${ownerKey(call.argumentOwner)}:${deferredCallableKey(call.callee)}:${call.node.getStart()}:${JSON.stringify(call.argumentFacts)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function summaryKey(summary: CallableSummary): string {
  const effects = (flows: readonly ImplicitFlow[], writes: readonly ParameterWrite[], calls: readonly DeferredCall[]) => ({
    flows: flows.map((flow) => [flow.kind, flow.description, flow.node.getStart(), flow.defaultParameterIndex,
      flow.binding && externalBindingOrigin(flow.binding), flow.access, flow.path, flow.receiver, flow.parameterIndex,
      flow.writeNode?.getStart(), flow.origins, flow.argumentWrite, flow.readParameterIndex, flow.reads]).sort(),
    writes: writes.map((write) => [write.parameterIndex, write.path, write.description, write.node.getStart(),
      write.defaultParameterIndex, write.writeNode?.getStart()]).sort(),
    calls: calls.map((call) => [ownerKey(call.owner), ownerKey(call.argumentOwner), deferredCallableKey(call.callee), call.node.getStart(), call.argumentFacts, call.defaultParameterIndex]).sort(),
  });
  return JSON.stringify({
    ...effects(summary.flows, summary.parameterWrites, summary.deferredCalls),
    insertions: summary.storageInsertions.map((insertion) => [insertion.node.getStart(), insertion.origin.getStart(), insertion.kind,
      insertion.target, insertion.value, insertion.slot, insertion.appendCall?.getStart(), insertion.replace]),
    resets: summary.arrayResets,
    yielded: summary.yieldedAliases,
    aliases: summary.returnedAliases.map((fact) => [fact.outer, fact.reachable, fact.cells]).sort(),
    runs: summary.returnedRuns && effects(summary.returnedRuns.flows, summary.returnedRuns.writes, summary.returnedRuns.deferredCalls),
  });
}

function clearEpoch(state: AnalysisState): void {
  state.factCache.clear();
  state.insertionCache.clear();
}

function analyzeImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const model = analyzeScopes(sourceFile);
  const state = collectCallables(sourceFile, model, includeThis);
  const summaries = new Map<EffectOwner, CallableSummary>(state.callables.map((owner) => [
    owner,
    { owner, flows: [], parameterWrites: [], deferredCalls: [], storageInsertions: [], arrayResets: [], returnedAliases: [], yieldedAliases: [] },
  ]));
  state.summaries = summaries;
  const keys = new Map<EffectOwner, string>();
  const bottomUp = [...state.callables].reverse();
  let converged = false;
  for (let index = 0; index < state.callables.length + 8; index += 1) {
    clearEpoch(state);
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
        clearEpoch(state);
      }
    }
    if (!changed && sharedCount === sharedBindingCount(state)) {
      converged = true;
      break;
    }
  }
  const flows: ImplicitFlow[] = [];
  for (const summary of reportedSummaries(summaries)) {
    if (!converged) {
      flows.push(...unknownEffects(summary.owner, summary.owner, "has effects this analysis did not resolve").flows);
    }
    flows.push(...summary.flows);
    flows.push(...summary.parameterWrites.map((write) => ({
      kind: "output" as const,
      node: write.node,
      owner: summary.owner,
      description: write.description,
      parameterIndex: write.parameterIndex,
    })));
    flows.push(...summary.deferredCalls.map((call) => ({
      kind: "unknown" as const,
      node: call.node,
      owner: summary.owner,
      description: "calls unresolved callable",
    })));
  }
  return uniqueLines(uniqueFlows(firstStorageSites(withoutPassedReads(state, summaries, flows))));
}

/**
 * Gives the summaries whose effects the report shows. An implicit constructor's call to a resolved base constructor
 * has no source of its own, and the base constructor reports those effects, so only callers see them.
 */
function reportedSummaries(summaries: ReadonlyMap<EffectOwner, CallableSummary>): CallableSummary[] {
  return [...summaries.values()].map((summary) => {
    const base = ts.isClassLike(summary.owner) ? baseClassExpression(summary.owner) : undefined;
    if (!base) { return summary; }
    const own = (effect: { readonly node: ts.Node; readonly description?: string }) =>
      effect.node !== base || effect.description === "constructs unresolved base class";
    return { ...summary, flows: summary.flows.filter(own), parameterWrites: summary.parameterWrites.filter(own), deferredCalls: summary.deferredCalls.filter(own) };
  });
}

function firstStorageSites(flows: readonly ImplicitFlow[]): ImplicitFlow[] {
  const first = new Map<string, ImplicitFlow>();
  for (const flow of flows) {
    for (const key of flowStorageKeys(flow)) {
      const earlier = first.get(key);
      if (!earlier || flow.node.getStart() < earlier.node.getStart()) { first.set(key, flow); }
    }
  }
  return flows.filter((flow) => {
    const keys = flowStorageKeys(flow);
    return keys.length === 0 || keys.some((key) => first.get(key) === flow);
  });
}

function flowStorageKeys(flow: ImplicitFlow): readonly string[] {
  const origins = flow.origins?.length ? flow.origins : flow.binding ? [externalBindingOrigin(flow.binding)]
    : flow.parameterIndex === undefined ? [] : [`param:${flow.parameterIndex}` satisfies StorageOrigin];
  return origins.map((origin) => {
    const projection = externalProjection(origin) ?? parameterProjection(origin);
    const root = externalProjection(origin)?.base ?? (parameterProjection(origin) ? `param:${parameterProjection(origin)?.parameterIndex}` : origin);
    const path = [...projection?.path ?? [], ...Array.isArray(flow.path) ? flow.path : []];
    return `${ownerKey(flow.owner)}:${flow.kind}:${root}:${JSON.stringify(path)}`;
  });
}

/**
 * Drops the read of a binding passed straight to a call that resolves to nothing, since that call's unknown effect
 * already covers what it does with the argument. A call that resolves keeps the reads its callees make.
 */
function withoutPassedReads(state: AnalysisState, summaries: ReadonlyMap<EffectOwner, CallableSummary>, flows: readonly ImplicitFlow[]): ImplicitFlow[] {
  return flows.filter((flow) => {
    const passed = flow.kind === "input" && ts.isIdentifier(flow.node) && !reassigned(state.model, flow.binding) ? argumentCall(flow.node) : undefined;
    const call = passed && resolveTargets(dispatchFor(state, summaries), passed.expression).targets.length === 0 ? passed : undefined;
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
  const keyFor = (flow: ImplicitFlow): string => {
    const line = flow.node.getSourceFile().getLineAndCharacterOfPosition(flow.node.getStart()).line;
    return `${ownerKey(flow.owner)}:${flow.kind}:${line}`;
  };
  return deduplicateFlows(flows, keyFor);
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
