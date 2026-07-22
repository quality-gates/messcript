import ts from "typescript";
import type { ClassLike } from "../ast/classes";
import { getClassContext } from "../ast/classes";
import type { Finding } from "../finding";

export function createClassFinding(
  node: ClassLike,
  sourceFile: ts.SourceFile,
  ruleName: string,
  priority: number,
  messageForContext: (context: string) => string,
): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const context = getClassContext(node, sourceFile);

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
