import ts from "typescript";

type ExpressionWrapper = ts.Expression & { expression: ts.Expression };

// Wrappers do not change the value of the expression they hold.
function isWrapper(node: ts.Node): node is ExpressionWrapper {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node);
}

/** Removes parentheses, type assertions, non-null assertions, and satisfies clauses around an expression. */
export function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (isWrapper(current)) {
    current = current.expression;
  }
  return current;
}

/** Gives the outermost wrapper around the expression, or the expression when it has no wrapper. */
export function outerExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (isWrapper(current.parent)) {
    current = current.parent;
  }
  return current;
}

/** Gives the literal method name of a callee, as "push" for a.push and a["push"]. */
export function methodName(callee: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  const argument = ts.isElementAccessExpression(callee) ? unwrapExpression(callee.argumentExpression) : undefined;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}
