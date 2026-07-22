import type { FunctionLike } from "../ast/functions";
import { getFunctionContext } from "../ast/functions";
import type { Finding } from "../finding";
import ts from "typescript";

export function createFunctionFinding(
  node: FunctionLike,
  sourceFile: ts.SourceFile,
  ruleName: string,
  priority: number,
  messageForContext: (context: string) => string,
): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const context = getFunctionContext(node, sourceFile);

  return {
    path: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    ruleName,
    priority,
    context,
    message: messageForContext(context),
  };
}

