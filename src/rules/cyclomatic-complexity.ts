import ts from "typescript";
import { forEachFunction, isFunctionLikeWithBody } from "../ast/functions";
import type { FunctionLike } from "../ast/functions";
import type { Finding } from "../finding";
import { hasOptionalChain, isDecisionOperator } from "../metrics/decisions";
import { createFunctionFinding } from "./function-finding";

export const ruleName = "CyclomaticComplexity";
export const priority = 3;
export const reportLevel = 10;

function countDecisionPoints(root: ts.Node): number {
  let decisions = 0;

  function visit(node: ts.Node): void {
    if (node !== root && isFunctionLikeWithBody(node)) {
      return;
    }

    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      hasOptionalChain(node)
    ) {
      decisions += 1;
    }

    if (ts.isBinaryExpression(node) && isDecisionOperator(node.operatorToken.kind)) {
      decisions += 1;
    }

    ts.forEachChild(node, visit);
  }

  visit(root);
  return decisions + 1;
}

function createCyclomaticComplexityFinding(
  node: FunctionLike,
  sourceFile: ts.SourceFile,
  complexity: number,
): Finding {
  return createFunctionFinding(node, sourceFile, ruleName, priority, (context) =>
    `The ${context} has a Cyclomatic Complexity of ${complexity}. The configured cyclomatic complexity threshold is ${reportLevel}.`,
  );
}

export function findCyclomaticComplexity(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];

  forEachFunction(sourceFile, (node) => {
    const body = node.body;
    if (body) {
      const complexity = countDecisionPoints(body);
      if (complexity > reportLevel) {
        findings.push(createCyclomaticComplexityFinding(node, sourceFile, complexity));
      }
    }
  });
  return findings;
}
