// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { visitExecutableRegions, walkExecutableRegion } from "../ast/executable-regions";
import type { Finding } from "../finding";
import { locate } from "../location";
import { createCleanCodeFinding, functionContext } from "./clean-code-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "IfStatementAssignment";
export const priority = 1;
export const properties = {} as const;

function isAssignmentOperator(node: ts.BinaryExpression): boolean {
  return node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function addConditionFindings(
  condition: ts.Expression,
  sourceFile: ts.SourceFile,
  context: string,
  findings: Finding[],
): void {
  const assignments: ts.BinaryExpression[] = [];
  walkExecutableRegion(condition, (node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node)) {
      assignments.push(node);
    }
  });
  for (const assignment of assignments) {
    const position = locate(sourceFile, assignment.getStart(sourceFile));
    findings.push(
      createCleanCodeFinding(
        assignment,
        sourceFile,
        ruleName,
        priority,
        context,
        `Avoid assigning values to variables in if clauses and the like (line '${position.line + 1}', column '${position.character + 1}').`,
      ),
    );
  }
}

export function findIfStatementAssignment(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  visitExecutableRegions(sourceFile, (node, owner) => {
    let condition: ts.Expression | undefined;
    if (
      ts.isIfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node)
    ) {
      condition = node.expression;
    } else if (ts.isForStatement(node)) {
      condition = node.condition;
    }
    if (condition) {
      const context = ts.isSourceFile(owner) ? "module" : functionContext(owner, sourceFile);
      addConditionFindings(condition, sourceFile, context, findings);
    }
  });
  return findings;
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findIfStatementAssignment(sourceFile),
};
