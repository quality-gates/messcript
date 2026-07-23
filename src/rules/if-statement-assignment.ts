// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunction, isFunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { createCleanCodeFinding, functionContext } from "./clean-code-finding";

export const ruleName = "IfStatementAssignment";
export const priority = 1;
export const properties = {} as const;

function findAssignments(node: ts.Node, assignments: ts.BinaryExpression[]): void {
  if (isFunctionLike(node)) {
    return;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    assignments.push(node);
  }
  ts.forEachChild(node, (child) => findAssignments(child, assignments));
}

function addConditionFindings(
  condition: ts.Expression,
  sourceFile: ts.SourceFile,
  context: string,
  findings: Finding[],
): void {
  const assignments: ts.BinaryExpression[] = [];
  findAssignments(condition, assignments);
  for (const assignment of assignments) {
    const position = sourceFile.getLineAndCharacterOfPosition(assignment.getStart(sourceFile));
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
  forEachFunction(sourceFile, (node) => {
    if (!node.body) {
      return;
    }
    const context = functionContext(node, sourceFile);
    function visit(bodyNode: ts.Node): void {
      if (isFunctionLike(bodyNode)) {
        return;
      }
      if (ts.isIfStatement(bodyNode)) {
        addConditionFindings(bodyNode.expression, sourceFile, context, findings);
      } else if (ts.isWhileStatement(bodyNode) || ts.isDoStatement(bodyNode)) {
        addConditionFindings(bodyNode.expression, sourceFile, context, findings);
      }
      ts.forEachChild(bodyNode, visit);
    }
    visit(node.body);
  });
  return findings;
}
