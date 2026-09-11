// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunction, isFunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { locate } from "../location";
import { createCleanCodeFinding, functionContext } from "./clean-code-finding";

export const ruleName = "IfStatementAssignment";
export const priority = 1;
export const properties = {} as const;

function isAssignmentOperator(node: ts.BinaryExpression): boolean {
  return node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function findAssignments(node: ts.Node, assignments: ts.BinaryExpression[]): void {
  if (isFunctionLike(node)) {
    return;
  }
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node)) {
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

function visitExecutableStatements(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  context: string,
  findings: Finding[],
): void {
  if (isFunctionLike(node)) {
    return;
  }
  if (
    ts.isIfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node)
  ) {
    addConditionFindings(node.expression, sourceFile, context, findings);
  } else if (ts.isForStatement(node) && node.condition) {
    addConditionFindings(node.condition, sourceFile, context, findings);
  }
  ts.forEachChild(node, (child) => visitExecutableStatements(child, sourceFile, context, findings));
}

export function findIfStatementAssignment(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  visitExecutableStatements(sourceFile, sourceFile, "module", findings);
  forEachFunction(sourceFile, (node) => {
    if (!node.body) {
      return;
    }
    const context = functionContext(node, sourceFile);
    visitExecutableStatements(node.body, sourceFile, context, findings);
  });
  return findings;
}
