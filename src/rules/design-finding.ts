import ts from "typescript";
import { getFunctionContext, isFunctionLike } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import type { Finding } from "../finding";

export function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

export function functionContextFor(node: ts.Node, sourceFile: ts.SourceFile): string {
  const functionNode = isFunctionLike(node) ? node : enclosingFunction(node);
  return functionNode ? getFunctionContext(functionNode, sourceFile) : "module";
}

export function createDesignFinding(
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

export function createDesignFindingAt(
  sourceFile: ts.SourceFile,
  position: number,
  ruleName: string,
  priority: number,
  context: string,
  message: string,
): Finding {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    path: sourceFile.fileName,
    line: location.line + 1,
    column: location.character + 1,
    ruleName,
    priority,
    context,
    message,
  };
}
