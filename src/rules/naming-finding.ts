import ts from "typescript";
import type { Finding } from "../finding";

export function createNamingFinding(
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
