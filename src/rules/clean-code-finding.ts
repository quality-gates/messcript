import ts from "typescript";
import { getFunctionContext, getFunctionName } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import type { ClassLike } from "../ast/classes";
import type { Finding } from "../finding";

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: readonly ts.Modifier[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

export function enclosingClass(node: ts.Node): ClassLike | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

export function className(node: ClassLike): string | undefined {
  if (node.name) {
    return node.name.text;
  }
  if (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

export function functionName(node: FunctionLike, sourceFile: ts.SourceFile): string {
  return getFunctionName(node, sourceFile) ?? (ts.isConstructorDeclaration(node) ? "constructor" : "anonymous");
}

export function functionImage(node: FunctionLike, sourceFile: ts.SourceFile): string {
  const name = functionName(node, sourceFile);
  const owner = enclosingClass(node);
  const ownerName = owner ? className(owner) : undefined;
  return ownerName ? `${ownerName}::${name}` : name;
}

export function functionContext(node: FunctionLike, sourceFile: ts.SourceFile): string {
  return getFunctionContext(node, sourceFile);
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isExternalModule(sourceFile: ts.SourceFile): boolean {
  return Boolean((sourceFile as ts.SourceFile & { externalModuleIndicator?: ts.Node }).externalModuleIndicator);
}

function exportedVariableFunction(node: FunctionLike, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
    if (ts.isVariableStatement(current)) {
      return hasExportModifier(current) || !isExternalModule(sourceFile);
    }
    current = current.parent;
  }
  return false;
}

export function isPublicFunction(node: FunctionLike, sourceFile: ts.SourceFile): boolean {
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) {
    if (hasModifier(node, ts.SyntaxKind.PrivateKeyword) || hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) {
      return false;
    }
    return !(node.name && ts.isPrivateIdentifier(node.name));
  }
  if (ts.isFunctionDeclaration(node)) {
    return hasExportModifier(node) || !isExternalModule(sourceFile);
  }
  return exportedVariableFunction(node, sourceFile);
}

export function createCleanCodeFinding(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  ruleName: string,
  priority: number,
  context: string,
  message: string,
): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    path: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    ruleName,
    priority,
    context,
    message,
  };
}
