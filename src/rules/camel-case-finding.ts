import ts from "typescript";
import type { Finding } from "../finding";
import { locate } from "../location";

export function createCamelCaseFinding(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  ruleName: string,
  context: string,
  message: string,
): Finding {
  const position = locate(sourceFile, node.getStart(sourceFile));
  return {
    path: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    ruleName,
    priority: 1,
    context,
    message,
  };
}
