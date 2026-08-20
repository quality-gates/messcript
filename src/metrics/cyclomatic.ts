import ts from "typescript";
import { isFunctionLikeWithBody } from "../ast/functions";
import { walkAst } from "../ast/walk";
import { hasOptionalChain, isDecisionOperator } from "./decisions";

function isStatementDecision(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node)
  );
}

function isExpressionDecision(node: ts.Node): boolean {
  return ts.isConditionalExpression(node) || hasOptionalChain(node);
}

export function calculateCyclomaticComplexity(root: ts.ConciseBody): number {
  let decisions = 0;
  walkAst(root, (node) => {
    if (node !== root && isFunctionLikeWithBody(node)) {
      return false;
    }

    if (isStatementDecision(node) || isExpressionDecision(node)) {
      decisions += 1;
    }

    if (ts.isBinaryExpression(node) && isDecisionOperator(node.operatorToken.kind)) {
      decisions += 1;
    }
  });
  return decisions + 1;
}
