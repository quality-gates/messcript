import ts from "typescript";

export function hasOptionalChain(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node) && !ts.isCallExpression(node)) {
    return false;
  }

  return (node as ts.Node & { questionDotToken?: ts.QuestionDotToken }).questionDotToken !== undefined;
}

export function isDecisionOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

