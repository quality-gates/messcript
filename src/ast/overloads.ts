// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { locate } from "../location";
import { isFunctionLike } from "./functions";
import type { FunctionLike } from "./functions";

export type CallableGroup = {
  primaryDeclaration: FunctionLike;
  declarations: readonly FunctionLike[];
  implementation?: FunctionLike;
  declarationLines: readonly number[];
};

export type MethodSignatureGroup = {
  primaryDeclaration: ts.MethodSignature;
  declarations: readonly ts.MethodSignature[];
  declarationLines: readonly number[];
};

export type ParameterizedGroup = {
  signatures: readonly (
    | FunctionLike
    | ts.MethodSignature
    | ts.CallSignatureDeclaration
    | ts.ConstructSignatureDeclaration
    | ts.FunctionTypeNode
    | ts.ConstructorTypeNode
  )[];
  declarationLines: readonly number[];
};

export type OverloadAnalysis = {
  callableGroups: readonly CallableGroup[];
  methodSignatureGroups: readonly MethodSignatureGroup[];
  parameterizedGroups: readonly ParameterizedGroup[];
};

function nodeLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return locate(sourceFile, node.getStart(sourceFile)).line + 1;
}

function isStaticMember(node: ts.MethodDeclaration): boolean {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

function memberNameText(name: ts.PropertyName | ts.BindingName | undefined, sourceFile: ts.SourceFile): string {
  return name ? name.getText(sourceFile) : "";
}

function getSignatureLines(
  nodes: readonly (ts.Node & { parameters?: ts.NodeArray<ts.ParameterDeclaration> })[],
  sourceFile: ts.SourceFile,
): number[] {
  const lines: number[] = [];
  for (const node of nodes) {
    lines.push(nodeLine(sourceFile, node));
    if (node.parameters) {
      for (const parameter of node.parameters) {
        lines.push(nodeLine(sourceFile, parameter));
      }
    }
  }
  return [...new Set(lines)];
}

function groupFunctionDeclarations(
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile,
  callableGroups: CallableGroup[],
  parameterizedGroups: ParameterizedGroup[],
): void {
  const groups = new Map<string, ts.FunctionDeclaration[]>();
  const orderedKeys: string[] = [];

  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name ? statement.name.text : "";
      const list = groups.get(name);
      if (list) {
        list.push(statement);
      } else {
        orderedKeys.push(name);
        groups.set(name, [statement]);
      }
    }
  }

  for (const key of orderedKeys) {
    const list = groups.get(key)!;
    const primary = list[0];
    const impl = list.find((fn) => fn.body !== undefined);
    const lines = getSignatureLines(list, sourceFile);
    callableGroups.push({
      primaryDeclaration: primary,
      declarations: list,
      implementation: impl,
      declarationLines: lines,
    });
    parameterizedGroups.push({
      signatures: list,
      declarationLines: lines,
    });
  }
}

type ClassMemberItem =
  | { kind: "method"; key: string }
  | { kind: "constructor" }
  | { kind: "accessor"; member: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration };

// messcript-disable-next-line CyclomaticComplexity
function groupClassMembers(
  members: readonly ts.ClassElement[],
  sourceFile: ts.SourceFile,
  callableGroups: CallableGroup[],
  parameterizedGroups: ParameterizedGroup[],
): void {
  const methodGroups = new Map<string, ts.MethodDeclaration[]>();
  const constructorGroup: ts.ConstructorDeclaration[] = [];
  const orderedItems: ClassMemberItem[] = [];

  for (const member of members) {
    if (ts.isMethodDeclaration(member)) {
      const isStatic = isStaticMember(member);
      const name = memberNameText(member.name, sourceFile);
      const key = isStatic ? `static:${name}` : `instance:${name}`;
      const list = methodGroups.get(key);
      if (list) {
        list.push(member);
      } else {
        orderedItems.push({ kind: "method", key });
        methodGroups.set(key, [member]);
      }
    } else if (ts.isConstructorDeclaration(member)) {
      if (constructorGroup.length === 0) {
        orderedItems.push({ kind: "constructor" });
      }
      constructorGroup.push(member);
    } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      orderedItems.push({ kind: "accessor", member });
    }
  }

  for (const item of orderedItems) {
    if (item.kind === "method") {
      const list = methodGroups.get(item.key)!;
      const primary = list[0];
      const impl = list.find((method) => method.body !== undefined);
      const lines = getSignatureLines(list, sourceFile);
      callableGroups.push({
        primaryDeclaration: primary,
        declarations: list,
        implementation: impl,
        declarationLines: lines,
      });
      parameterizedGroups.push({
        signatures: list,
        declarationLines: lines,
      });
    } else if (item.kind === "constructor") {
      const lines = getSignatureLines(constructorGroup, sourceFile);
      parameterizedGroups.push({
        signatures: constructorGroup,
        declarationLines: lines,
      });
    } else {
      const lines = getSignatureLines([item.member], sourceFile);
      callableGroups.push({
        primaryDeclaration: item.member,
        declarations: [item.member],
        implementation: item.member.body !== undefined ? item.member : undefined,
        declarationLines: lines,
      });
      parameterizedGroups.push({
        signatures: [item.member],
        declarationLines: lines,
      });
    }
  }
}

type TypeMemberItem =
  | { kind: "method"; key: string }
  | { kind: "call" }
  | { kind: "construct" };

// messcript-disable-next-line CyclomaticComplexity
function groupTypeMembers(
  members: readonly ts.TypeElement[],
  sourceFile: ts.SourceFile,
  methodSignatureGroups: MethodSignatureGroup[],
  parameterizedGroups: ParameterizedGroup[],
): void {
  const methodSigGroups = new Map<string, ts.MethodSignature[]>();
  const callSigGroup: ts.CallSignatureDeclaration[] = [];
  const constructSigGroup: ts.ConstructSignatureDeclaration[] = [];
  const orderedItems: TypeMemberItem[] = [];

  for (const member of members) {
    if (ts.isMethodSignature(member)) {
      const name = memberNameText(member.name, sourceFile);
      const list = methodSigGroups.get(name);
      if (list) {
        list.push(member);
      } else {
        orderedItems.push({ kind: "method", key: name });
        methodSigGroups.set(name, [member]);
      }
    } else if (ts.isCallSignatureDeclaration(member)) {
      if (callSigGroup.length === 0) {
        orderedItems.push({ kind: "call" });
      }
      callSigGroup.push(member);
    } else if (ts.isConstructSignatureDeclaration(member)) {
      if (constructSigGroup.length === 0) {
        orderedItems.push({ kind: "construct" });
      }
      constructSigGroup.push(member);
    }
  }

  for (const item of orderedItems) {
    if (item.kind === "method") {
      const list = methodSigGroups.get(item.key)!;
      const primary = list[0];
      const lines = getSignatureLines(list, sourceFile);
      methodSignatureGroups.push({
        primaryDeclaration: primary,
        declarations: list,
        declarationLines: lines,
      });
      parameterizedGroups.push({
        signatures: list,
        declarationLines: lines,
      });
    } else if (item.kind === "call") {
      const lines = getSignatureLines(callSigGroup, sourceFile);
      parameterizedGroups.push({
        signatures: callSigGroup,
        declarationLines: lines,
      });
    } else {
      const lines = getSignatureLines(constructSigGroup, sourceFile);
      parameterizedGroups.push({
        signatures: constructSigGroup,
        declarationLines: lines,
      });
    }
  }
}

// messcript-disable-next-line CyclomaticComplexity
function collectOverloads(sourceFile: ts.SourceFile): OverloadAnalysis {
  const callableGroups: CallableGroup[] = [];
  const methodSignatureGroups: MethodSignatureGroup[] = [];
  const parameterizedGroups: ParameterizedGroup[] = [];

  // messcript-disable-next-line CyclomaticComplexity NPathComplexity
  function visit(node: ts.Node): void {
    if (ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isBlock(node)) {
      groupFunctionDeclarations(node.statements, sourceFile, callableGroups, parameterizedGroups);
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      groupClassMembers(node.members, sourceFile, callableGroups, parameterizedGroups);
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      groupTypeMembers(node.members, sourceFile, methodSignatureGroups, parameterizedGroups);
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const lines = getSignatureLines([node], sourceFile);
      callableGroups.push({
        primaryDeclaration: node,
        declarations: [node],
        implementation: node,
        declarationLines: lines,
      });
      parameterizedGroups.push({
        signatures: [node],
        declarationLines: lines,
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
      const lines = getSignatureLines([node], sourceFile);
      parameterizedGroups.push({
        signatures: [node],
        declarationLines: lines,
      });
      ts.forEachChild(node, visit);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    callableGroups,
    methodSignatureGroups,
    parameterizedGroups,
  };
}

// messcript-disable-next-line GlobalVariable
const overloadCache = new WeakMap<ts.SourceFile, OverloadAnalysis>();

export function analyzeOverloads(sourceFile: ts.SourceFile): OverloadAnalysis {
  let result = overloadCache.get(sourceFile);
  if (!result) {
    result = collectOverloads(sourceFile);
    overloadCache.set(sourceFile, result);
  }
  return result;
}

export function forEachCallableDeclaration(
  sourceFile: ts.SourceFile,
  callback: (
    node: FunctionLike,
    declarationLines: readonly number[],
    implementation?: FunctionLike,
  ) => void,
): void {
  const analysis = analyzeOverloads(sourceFile);
  for (const group of analysis.callableGroups) {
    callback(group.primaryDeclaration, group.declarationLines, group.implementation);
  }
}

export function forEachMethodSignatureDeclaration(
  sourceFile: ts.SourceFile,
  callback: (node: ts.MethodSignature, declarationLines: readonly number[]) => void,
): void {
  const analysis = analyzeOverloads(sourceFile);
  for (const group of analysis.methodSignatureGroups) {
    callback(group.primaryDeclaration, group.declarationLines);
  }
}
