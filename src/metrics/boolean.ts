import ts from "typescript";

export function isBooleanType(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  if (
    type.kind === ts.SyntaxKind.BooleanKeyword ||
    type.kind === ts.SyntaxKind.TrueKeyword ||
    type.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return type.typeName.text === "Boolean";
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return isBooleanType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every((member) => isBooleanType(member) || member.kind === ts.SyntaxKind.UndefinedKeyword || member.kind === ts.SyntaxKind.NullKeyword);
  }
  return false;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
export function isBooleanExpression(expression: ts.Expression): boolean {
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (ts.isBinaryExpression(expression)) {
    return [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.InKeyword,
      ts.SyntaxKind.InstanceOfKeyword,
    ].includes(expression.operatorToken.kind);
  }
  if (ts.isConditionalExpression(expression)) {
    return isBooleanExpression(expression.whenTrue) && isBooleanExpression(expression.whenFalse);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return isBooleanType(expression.type);
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text === "Boolean";
  }
  return false;
}
