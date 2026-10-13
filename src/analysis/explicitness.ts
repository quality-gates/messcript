// messcript-disable ConstantNamingConventions CouplingBetweenObjects
import ts from "typescript";
import { globalName } from "../ast/global-reference";
import { isFunctionLike, isFunctionLikeWithBody } from "../ast/functions";
import { methodName, outerExpression, unwrapExpression } from "../ast/expressions";
import { analyzeScopes, isAmbient } from "../ast/scopes";
import type { Binding, ScopeModel, Write } from "../ast/scopes";
import { reachableChildren } from "./control-flow";
import { bindingAssignments, canReachSite, inside, unconditional } from "./assignments";
import { callableTargets as resolveTargets, classTargets, memberTargets, type Dispatch, type Targets } from "./dispatch";
import { ambientFlow, isPureConstructor, iteratedArgument, libraryCall, libraryCallback, type LibraryCall, type LibraryStorage } from "./library";
import { protocolExpressions, supportsProtocol } from "./protocols";
import {
  baseClassExpression, collectOwners, enclosingClass, explicitConstructor, instanceInitializers, isConstruction,
  isGenerator, isInstanceField, ownerKey, ownerParameters, type EffectOwner,
} from "./owners";
import {
  expressionStorageFact,
  externalBindingOrigin,
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

/** A write at the site that changes the slot of a local origin; a missing slot is every slot. */
type SharedWrite = { readonly fact: StorageFact; readonly origin: StorageOrigin; readonly site: ts.Node; readonly slot?: string };

type AnalysisState = {
  readonly model: ScopeModel;
  readonly sourceFile: ts.SourceFile;
  readonly callables: readonly EffectOwner[];
  summaries: ReadonlyMap<EffectOwner, CallableSummary>;
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

/**
 * Tells if the read reaches storage that a declare statement or a global augmentation leaves to code outside the file:
 * an ambient variable, or a static member of an ambient class.
 */
function isAmbientStorage(binding: Binding, node: ts.Identifier): boolean {
  const member = memberAccessOn(node);
  return binding.declarations.some((declaration) => isAmbient(declaration.node) &&
    (ts.isVariableDeclaration(declaration.node) || (ts.isClassDeclaration(declaration.node) && !!member && !isThisMethodCall(member))));
}

/**
 * Gives the flow of an unbound name that names a namespace in the file.
 * Code outside the file can change an ambient namespace, and a namespace exports its variables.
 * A namespace member that is a function, class, enum, namespace, or scalar constant is not storage.
 */
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
  if (!binding) {
    const flow = ambientFlow(node, write !== undefined) ?? namespaceFlow(node, write);
    return flow ? withCompoundRead(write, { kind: flow[0], node, owner, description: flow[1] }) : [];
  }
  if (aliasOf(state.model, node)) {
    return [];
  }
  const shared = bindingSharesRead(state, binding, node, owner);
  const direct = bindingFlow(binding, node, owner, write, shared);
  const target = direct ? undefined : aliasTarget(state.model, binding, new Set());
  const flow = direct ?? (target && bindingFlow(target, node, owner, write, shared || bindingSharesRead(state, target, node, owner)));
  return flow
    ? withCompoundRead(write, { kind: flow[0], node, owner, description: flow[1], ...bindingAccess(direct ? binding : target ?? binding, node, write) })
    : [];
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

/** Gives the constant binding that a chain of constant aliases copies, as log for b in const a = log; const b = a. */
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
  return sharedMarkAffectsRead(state, binding, node) || capturedReadSharesMutation(state, binding, node, owner) ||
    directMutationAffectsRead(state, binding, node);
}

function sharedMarkAffectsRead(state: AnalysisState, binding: Binding, node: ts.Identifier): boolean {
  const marks = state.sharedBindings.get(binding);
  const path = selectedReadSlots(node);
  return !!marks && [...marks].some((mark) => {
    const slots = JSON.parse(mark) as string[];
    const prefix = slots.slice(0, -1);
    const slot = slots[slots.length - 1];
    return pathsOverlap(path, prefix) &&
      (path.length <= prefix.length || slot === "*" || mutationSlotOverlaps(path.slice(prefix.length), slot));
  });
}

function capturedReadSharesMutation(state: AnalysisState, binding: Binding, node: ts.Identifier, owner: EffectOwner): boolean {
  const writes = state.sharedLocalBindings.get(binding);
  if (!writes || inside(binding.scope.node, owner)) {
    return false;
  }
  const path = selectedReadSlots(node);
  return [...writes.values()].some(({ fact, origin, slot }) =>
    Array.from({ length: path.length + 1 }, (_, length) => length)
      .some((length) => originsForPath(fact, length ? path.slice(0, length) : "outer").includes(origin) &&
        (slot === undefined || mutationSlotOverlaps(path.slice(length), slot))));
}

function selectedReadSlots(node: ts.Identifier): string[] {
  const slots: string[] = [];
  let current: ts.Expression = outerExpression(node);
  while ((ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current) {
    const access = current.parent;
    const callee = outerExpression(access);
    if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee) {
      break;
    }
    slots.push(storageSlot(access) ?? "*");
    current = outerExpression(access);
  }
  return slots;
}

function mutationSlotOverlaps(path: readonly string[], slot: string): boolean {
  if (slot.startsWith("append:")) {
    const selected = path[0];
    if (selected === undefined || selected === "*") {
      return true;
    }
    const index = arrayIndexForSlot(selected);
    return index !== undefined && index >= Number(slot.slice(7));
  }
  return pathsOverlap(path, [slot]);
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

function directMutationAffectsRead(state: AnalysisState, binding: Binding, read: ts.Identifier): boolean {
  if (!binding.mutated) {
    return false;
  }
  const readPath = selectedReadSlots(read);
  return binding.references.some((reference) => {
    const write = state.model.writeOf(reference);
    if (!write || write.viaCall || write.contents) {
      return false;
    }
    if (write.reassign) {
      return true;
    }
    const prefix = selectedSlots(reference).slice(0, -1);
    return pathsOverlap(readPath, prefix) && (readPath.length <= prefix.length ||
      assignedSlots(state, reference).some((slot) => slot === undefined || mutationSlotOverlaps(readPath.slice(prefix.length), slot)));
  });
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.slice(0, Math.min(left.length, right.length)).every((slot, index) =>
    slot === right[index] || slot === "*" || right[index] === "*");
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
  return {
    call: (call, owner, site, seen) =>
      ts.isCallExpression(call) ? joinedReturnFactForCall(state, summaries, call, owner, seen) : undefined,
    insertions: (owner, site) => (summaries.get(owner)?.storageInsertions ?? [])
      .filter((insertion) => canReachSite(insertion.node, owner, site))
      .map((insertion) => ({ ...insertion, replace: insertion.replace && insertion.node.end <= site.getStart() && unconditional(insertion.node, owner) })),
  };
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
  const arrayLiterals = new Map<number, ts.ArrayLiteralExpression>();
  const collectArrays = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node)) {
      arrayLiterals.set(node.getStart(), node);
    }
    ts.forEachChild(node, collectArrays);
  };
  collectArrays(sourceFile);
  return {
    model, sourceFile, callables: collectOwners(sourceFile), summaries: new Map(), includeThis,
    sharedBindings: new Map(), sharedLocalBindings: new Map(),
    bindingOrigins: new Map(model.bindings.map((binding) => [externalBindingOrigin(binding), binding])),
    arrayLiterals,
  };
}

/**
 * Marks the slots of each origin's binding that code outside the binding's owner can change. "*" marks every slot.
 * A mark is the member path from the binding to the changed storage followed by the changed slot.
 */
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

/** Gives the binding an external origin names and the member path the origin selects from it. */
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

/**
 * Gives the slots a closure write through a captured binding can change.
 * Only a root write to a never-reassigned array literal keeps a bound: a push lands at or after the literal's length,
 * because every write that shrinks the array marks the slots from its new length.
 */
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
  const write = state.model.writeOf(node);
  const push = pushCallForMutation(node);
  const slots = write && !write.contents ? assignedSlots(state, node)
    : push ? pushSlots(push, owner, { lowerBound: length, exact: false }) : [undefined];
  return slots.map((slot) => slot ?? "*");
}

/**
 * True when every invocation of the writing function is a direct call in the function that owns the binding.
 * Each such call records the slots its writes change there, so the call sites bound the write.
 */
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

/** True when the identifier always holds the array its single initializer creates. */
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

/** Gives the slots a member assignment through the identifier changes in the object it selects; undefined is every slot. */
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

/** Gives the least index an append by length, as values[values.length] = 1, can write: the array's least length there. */
function appendStart(state: AnalysisState, site: ts.Identifier, member: ts.ElementAccessExpression): number {
  const owner = enclosingFunction(site);
  const binding = state.model.resolve(site);
  const fact = owner && binding ? storageFactForBinding(state, state.summaries, binding, owner, member) : undefined;
  const origin = fact?.outer.length === 1 ? fact.outer[0] : undefined;
  const length = origin === undefined ? undefined : literalAllocationLength(state, origin);
  return owner && origin !== undefined && length !== undefined ? priorPushStart(state, owner, member, origin, length)?.lowerBound ?? 0 : 0;
}

function outermostAccess(site: ts.Identifier): ts.Expression {
  let access: ts.Expression = outerExpression(site);
  while ((ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) && access.parent.expression === access) {
    access = outerExpression(access.parent);
  }
  return access;
}

/** Gives the slots from a literal length assignment onward, or undefined for every slot. */
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
    if (!binding.declarations.some((declaration) =>
      (declaration.kind === "variable" || declaration.kind === "parameter") && inside(declaration.node, owner))) {
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

function mutatedSlots(state: AnalysisState, site: ts.Node, owner: EffectOwner): readonly (string | undefined)[] {
  if (ts.isIdentifier(site)) {
    const write = state.model.writeOf(site);
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

/**
 * A write a callee performs. A forwarded write comes from a deeper callee; a repeated write is one the callee can
 * perform more than once per call, such as a callback.
 */
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

/** Gives the slots a callee's push changes when the invocation runs the callee's body at once. */
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

/** A call or construction, the points a push start is computed at. */
type Invocation = ts.CallExpression | ts.NewExpression;

function invocationAt(site: ts.Node): Invocation | undefined {
  return isInvocation(site) ? site : isInvocation(site.parent) && site.parent.expression === site ? site.parent : undefined;
}

function isInvocation(node: ts.Node): node is Invocation {
  return ts.isCallExpression(node) || ts.isNewExpression(node);
}

/** The arguments evaluated as part of the point, which run before its callee's body. */
function pointArguments(point: ts.Node): readonly ts.Expression[] {
  return isInvocation(point) ? point.arguments ?? [] : [];
}

/**
 * Gives the slots a generator's push changes, or undefined for every slot. The body runs while the site forces the
 * iterator, interleaved with the consumer, so the push keeps only a lower bound: the least length the array can have
 * up to the end of the site, plus the generator's own earlier pushes.
 */
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

/** Gives the node whose evaluation forces a generator at the site, or undefined when the site does not force it. */
function forcingPoint(state: AnalysisState, site: ts.Node): ts.Node | undefined {
  if (iterates(site) || (ts.isCallExpression(site) && iteratorStep(site))) {
    return site;
  }
  return ts.isCallExpression(site.parent) && site.parent.expression === site && iteratedArgument(site.parent, state.model) !== undefined
    ? site.parent : undefined;
}

/** True when the node iterates its operand as part of its own evaluation. */
function iterates(node: ts.Node): boolean {
  return ts.isForOfStatement(node) || ts.isSpreadElement(node) || ts.isYieldExpression(node) || ts.isVariableDeclaration(node);
}

/** True when the call steps an iterator through next, return or throw. */
function iteratorStep(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    ["next", "return", "throw"].includes(methodName(callee) ?? "");
}

function transferOffset(state: AnalysisState, source: TransferSource, push: ts.CallExpression, sourceOwner: EffectOwner): PushStart | undefined {
  return source.writeNode || source.repeated ? { lowerBound: 0, exact: false } : calleePushOffset(state, push, sourceOwner);
}

/** True when the call can change an origin of the fact in a way other than appending. */
function invocationResets(state: AnalysisState, fact: StorageFact, invocation: Invocation): boolean {
  return sharedWrites(state).some((write) => write.slot === undefined && fact.outer.includes(write.origin) &&
    (write.site === invocation || write.site === invocation.expression));
}

function sharedWrites(state: AnalysisState): SharedWrite[] {
  return [...state.sharedLocalBindings.values()].flatMap((writes) => [...writes.values()]);
}

/**
 * Gives where a direct push in a callee lands relative to the array's length at the call, or undefined when an
 * earlier effect of the callee can do anything other than append.
 */
function calleePushOffset(state: AnalysisState, push: ts.CallExpression, sourceOwner: EffectOwner): PushStart | undefined {
  const summary = state.summaries.get(sourceOwner);
  const target = pushReceiverKey(state, push);
  if (!summary || !target) {
    return undefined;
  }
  let offset: PushStart | undefined = { lowerBound: 0, exact: true };
  const counted = new Set<ts.CallExpression>([push]);
  for (const effect of [...summary.flows.filter(isWritingFlow), ...summary.parameterWrites]) {
    if (offset && mayRunBefore(effect.node, push, sourceOwner)) {
      offset = advanceCalleeOffset(state, offset, effect, target, counted, sourceOwner);
    }
  }
  return offset;
}

/** Counts one earlier write of the callee; a write other than a push leaves the offset unknown. */
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

/** Names the storage a push appends to as its root binding and literal member path, or undefined when either is unknown. */
function pushReceiverKey(state: AnalysisState, push: ts.CallExpression): string | undefined {
  const callee = unwrapExpression(push.expression);
  return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? storageKey(state, callee.expression) : undefined;
}

/** Names the storage an expression selects as its root binding and literal member path, or undefined when either is unknown. */
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

/** True when the node can run before the call: earlier in source, inside its arguments, or in a loop around both. */
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

/** Gives the length an array literal origin starts with, or undefined when the origin is not one or spreads. */
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

/** True when the reference runs in the owner before the point ends, outside the point's callee. */
function referenceBefore(reference: ts.Identifier, call: ts.Node, owner: EffectOwner): boolean {
  const callee = calleeOf(call);
  return !(callee && inside(reference, callee)) && inside(reference, owner) && !nestedFunctionBetween(reference, owner) &&
    (reference.getStart() < call.end || sharesLoop(reference, call, owner));
}

/** True when the node sits in code that runs later than its lexical position: a nested function or another class's instance field. */
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

/**
 * Gives the array's length bound just before the point, and the floor: the least lower bound at any earlier step,
 * which bounds the length throughout the steps.
 */
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

/**
 * Applies the writes calls and callbacks make to the origin before the push: an append keeps only a lower bound,
 * and any other write leaves the start unknown. Writes through the references already applied are skipped.
 */
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

/** Gives the callables an invocation runs: the resolved callees of a call, or the constructors of a construction. */
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

/** True when a direct push runs exactly once whenever its owner runs to completion. */
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

/**
 * Applies a direct write through the reference to the array's length. A write to an index never shrinks the array:
 * one below the start leaves it, and one at or past it keeps only a lower bound. A literal length assignment and a
 * pop that runs at most once give a new start. Any other write leaves it unknown.
 */
function priorArrayLengthWrite(
  state: AnalysisState,
  fact: StorageFact,
  origin: StorageOrigin,
  start: PushStart,
  reference: ts.Identifier,
  owner: EffectOwner,
): PushStart | undefined {
  const write = state.model.writeOf(reference);
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

/** Applies a write to the slot that follows the array at the depth of the reference's member path. */
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
  return prefix === path.length - 1 ? lengthChange(start, reference, path[prefix], owner) : undefined;
}

/** Applies a literal length assignment or a pop on the array the reference holds; undefined for anything else. */
function lengthChange(start: PushStart, reference: ts.Identifier, slot: string, owner: EffectOwner): PushStart | undefined {
  const access = outermostAccess(reference);
  const once = unconditional(access, owner);
  const truncated = slot === "property:length" ? truncatedSlot(access) : undefined;
  if (truncated !== undefined) {
    const length = Number(truncated.slice("append:".length));
    return once ? { lowerBound: length, exact: true } : { lowerBound: Math.min(start.lowerBound, length), exact: false };
  }
  const call = access.parent;
  if (slot !== "property:pop" || !ts.isCallExpression(call) || call.expression !== access || repeatedCall(call, owner)) {
    return undefined;
  }
  return { lowerBound: Math.max(start.lowerBound - 1, 0), exact: start.exact && once };
}

/** True when the access at the depth indexes its object by that object's own length, as in values[values.length]. */
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

/** True when both expressions select the same storage: one binding followed by the same literal member path. */
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
    case "fresh": return freshStorageFact(call);
    case "shallow": return shallowStorageFact(call, receiver);
    case "element": return libraryElementFact(call, receiver);
    case "receiver": return receiver;
    case "holding": return holdingReturnFact(state, summaries, call, owner, receiver);
    case "mapped": return mappedReturnFact(state, summaries, call, owner, known);
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
): StorageFact {
  const facts = call.arguments.map((argument) => storageFactForExpression(state, summaries, argument, owner, call));
  return allocatedFact(call, [receiver, ...facts].map((fact) => ({ slot: "*",
    fact: { ...fact, outer: [...fact.outer, ...fact.reachable] } })));
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
    instantiateStorageFact(invokedStorageFact(fact, call), (index) => actualFacts[index] ?? unknownFact),
  ));
  const callee = unwrapExpression(call.expression);
  const name = methodName(callee);
  if (name === "reduce" || name === "reduceRight") {
    return joinStorageFacts([call.arguments[1] ? storageFactForExpression(state, summaries, call.arguments[1], owner, call) : unknownFact, ...returns]);
  }
  return allocatedFact(call, returns.map((fact) => ({ slot: "*", fact })));
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
  return instantiateStorageFact(invokedStorageFact(fact, call), actualFact);
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
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = JSON.stringify({ outer: [...fact.outer].sort(), reachable: [...fact.reachable].sort(), cells: fact.cells });
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
  if (known) {
    return libraryEffects(state, summaries, call, owner, known);
  }
  escapeStorage(state, callOperandFacts(state, summaries, call, owner), call, owner);
  return unknownEffects(call.expression, owner, "calls unresolved callable");
}

/** Gives the storage a call hands to its callee: the receiver object of a member call and each argument. */
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

/**
 * Marks storage that reaches code this analysis cannot follow as changed in every slot.
 * The code can keep the reference, so every later reader of that storage can observe a change.
 */
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
    escapeStorage(state, callOperandFacts(state, summaries, call, owner), call, owner);
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
  const effects = instantiateCallbackTargets(state, summaries, resolved.targets, facts, node, owner, new Set());
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
  return { flows: [{ ...flow, node, owner, defaultParameterIndex: undefined, writeNode: flow.writeNode ?? flow.node }], writes: [], parameterCalls: [] };
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
  sourceOwner: EffectOwner,
): Pick<CallEffects, "flows" | "writes"> {
  return combineEffects(parameterWrites.map((write) => {
    const actual = actuals[write.parameterIndex];
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
  seen: Set<string>,
): CallEffects {
  const flows: ImplicitFlow[] = [];
  const writes: ParameterWrite[] = [];
  const forwardedCalls: ParameterCall[] = [];
  for (const parameterCall of parameterCalls) {
    const callback = actuals[parameterCall.parameterIndex];
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
  // A callback can run any number of times, so its pushes keep only a lower bound.
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

/** True when the expression selects storage through a bound name alone, so the name's own write reports the change. */
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
  storageInsertions: StorageInsertion[];
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
    flows: [], parameterWrites: [], parameterCalls: [], storageInsertions: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false,
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

/** Instantiates the storage insertions of resolved call or construction targets at one invocation. */
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
  const sites = ts.isCallExpression(call) && resolved.targets.every(isGenerator) ? generatorSites(state, call, owner) : [call];
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

function storageSlot(target: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(target)) {
    return `property:${target.name.text}`;
  }
  const key = unwrapExpression(target.argumentExpression);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? `property:${key.text}` : undefined;
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
  if (!target || known.stores === "none") {
    return [];
  }
  const args = known.stores === "sources" ? call.arguments.slice(1)
    : known.stores === "splice" ? call.arguments.slice(2) : call.arguments;
  const parts = libraryStoredArguments(state, call, owner, known.stores, args);
  return parts.map((part) => {
    const value = storageFactForExpression(state, summaries, part.expression, owner, call);
    return { kind: "cell", node: call, origin: part.expression, target: storageFactForExpression(state, summaries, target, owner, call),
      value: part.path === "reachable" ? elementFact(value) : value, slot: part.slot,
      appendCall: known.stores === "arguments" && methodName(unwrapExpression(call.expression)) === "push" ? call : undefined,
      replace: part.slot !== undefined && !part.slot.startsWith("append:") && unconditional(call, owner) };
  });
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
  const seen = new Set<string>();
  return insertions.filter((insertion) => {
    const key = JSON.stringify([insertion.node.getStart(), insertion.origin.getStart(), insertion.kind, insertion.target, insertion.value,
      insertion.slot, insertion.appendCall?.getStart(), insertion.replace]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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

/** Keeps every distinct contents write so callers can place each push; other flows keep one per description. */
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
  });
}

function analyzeImplicitFlows(sourceFile: ts.SourceFile, includeThis: boolean): ImplicitFlow[] {
  const model = analyzeScopes(sourceFile);
  const state = collectCallables(sourceFile, model, includeThis);
  let summaries = new Map<EffectOwner, CallableSummary>(state.callables.map((owner) => [
    owner,
    { owner, flows: [], parameterWrites: [], parameterCalls: [], storageInsertions: [], returnedAliases: [], returnedCallables: [], opaqueReturn: false },
  ]));
  let converged = false;
  for (let index = 0; index < state.callables.length + 8; index += 1) {
    state.summaries = summaries;
    let changed = false;
    const sharedCount = sharedBindingCount(state);
    const next = new Map<EffectOwner, CallableSummary>();
    for (const owner of state.callables) {
      const summary = summarizeCallable(state, summaries, owner, includeThis);
      shareExposedReturns(state, summary);
      next.set(owner, summary);
      changed ||= summaryKey(summary) !== summaryKey(summaries.get(owner) ?? summary);
    }
    summaries = next;
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

/**
 * Drops the read of a constant reference that a call takes as an argument when the same line reports the call as an unknown effect.
 * Passing a reference reads no contents; whatever the callee does with them is the unknown effect.
 */
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

// One line gives one finding per owner and kind, so two reasons for the same effect do not report it twice.
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
