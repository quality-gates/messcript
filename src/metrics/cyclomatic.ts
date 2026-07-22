import ts from "typescript";
import { isFunctionLikeWithBody } from "../ast/functions";
import { hasOptionalChain, isDecisionOperator } from "./decisions";

export function calculateCyclomaticComplexity(root: ts.ConciseBody): number {
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
