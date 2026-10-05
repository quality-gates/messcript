// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { createDesignFinding, functionContextFor } from "./design-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "EmptyCatchBlock";
export const priority = 2;
export const properties = {} as const;

function isEmptyBlock(block: ts.Block): boolean {
  return block.statements.every(
    (statement) => ts.isEmptyStatement(statement) || (ts.isBlock(statement) && isEmptyBlock(statement)),
  );
}

export function findEmptyCatchBlock(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node) && isEmptyBlock(node.block)) {
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

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findEmptyCatchBlock(sourceFile),
};
