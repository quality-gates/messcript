import ts from "typescript";
import type { Finding } from "../finding";
import { createDesignFinding, functionContextFor } from "./design-finding";

export const ruleName = "EmptyCatchBlock";
export const priority = 2;
export const properties = {} as const;

export function findEmptyCatchBlock(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      const context = functionContextFor(node, sourceFile);
      findings.push(
        createDesignFinding(
          node,
          sourceFile,
          ruleName,
          priority,
          context,
          `Avoid using empty catch blocks in ${context}.`,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}
