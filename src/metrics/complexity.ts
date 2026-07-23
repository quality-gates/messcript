import ts from "typescript";
import { isFunctionLikeWithBody } from "../ast/functions";
import { hasOptionalChain, isDecisionOperator } from "./decisions";

function expressionComplexity(node: ts.Node | undefined): number {
  if (!node) {
    return 0;
  }

  let decisions = 0;
  function visit(current: ts.Node): void {
    if (current !== node && isFunctionLikeWithBody(current)) {
      return;
    }
    if (
      ts.isConditionalExpression(current) ||
      hasOptionalChain(current) ||
      (ts.isBinaryExpression(current) && isDecisionOperator(current.operatorToken.kind))
    ) {
      decisions += 1;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return decisions;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function statementPaths(node: ts.Node): number {
  if (isFunctionLikeWithBody(node)) {
    return 1;
  }
  if (ts.isBlock(node)) {
    return sequencePaths(node.statements);
  }
  if (ts.isIfStatement(node)) {
    const thenPaths = statementPaths(node.thenStatement);
    const elsePaths = node.elseStatement ? statementPaths(node.elseStatement) : 1;
    return thenPaths + elsePaths + expressionComplexity(node.expression);
  }
  if (ts.isForStatement(node)) {
    return 1 + expressionComplexity(node.initializer) + expressionComplexity(node.condition) + expressionComplexity(node.incrementor) + statementPaths(node.statement);
  }
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return expressionComplexity(node.expression) + 1 + statementPaths(node.statement);
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return 1 + expressionComplexity(node.expression) + statementPaths(node.statement);
  }
  if (ts.isSwitchStatement(node)) {
    return (
      expressionComplexity(node.expression) +
      node.caseBlock.clauses.reduce((paths, clause) => paths + sequencePaths(clause.statements), 0)
    );
  }
  if (ts.isTryStatement(node)) {
    const catchPaths = node.catchClause ? statementPaths(node.catchClause.block) : 0;
    const finallyPaths = node.finallyBlock ? statementPaths(node.finallyBlock) : 0;
    return statementPaths(node.tryBlock) + catchPaths + finallyPaths;
  }
  if (ts.isExpressionStatement(node)) {
    return 1 + expressionComplexity(node.expression);
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.reduce(
      (paths, declaration) => paths + expressionComplexity(declaration.initializer),
      1,
    );
  }
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
    return 1 + expressionComplexity(node.expression);
  }

  return 1;
}

function sequencePaths(statements: readonly ts.Statement[]): number {
  return statements.reduce((paths, statement) => paths * statementPaths(statement), 1);
}

export function calculateNPathComplexity(body: ts.ConciseBody): number {
  return ts.isBlock(body) ? statementPaths(body) : 1 + expressionComplexity(body);
}
