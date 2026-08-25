import ts from "typescript";
import type { UnusedDeclaration, UnusedKind } from "../analysis/unused";
import type { Finding } from "../finding";
import { locate } from "../location";

export function createUnusedFinding(
  declaration: UnusedDeclaration,
  sourceFile: ts.SourceFile,
  ruleName: string,
  message: string,
): Finding {
  const position = locate(sourceFile, declaration.node.getStart(sourceFile));
  return {
    path: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    ruleName,
    priority: 3,
    context: declaration.context,
    message,
  };
}

export function unusedOfKind(declarations: readonly UnusedDeclaration[], kind: UnusedKind): UnusedDeclaration[] {
  return declarations.filter((declaration) => declaration.kind === kind && !declaration.used);
}
