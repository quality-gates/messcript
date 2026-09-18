import ts from "typescript";

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
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
  if (ts.isLiteralTypeNode(type)) {
    return type.literal.kind === ts.SyntaxKind.TrueKeyword || type.literal.kind === ts.SyntaxKind.FalseKeyword;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return type.typeName.text === "Boolean";
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return isBooleanType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return (
      type.types.some((member) => isBooleanType(member)) &&
      type.types.every(
        (member) =>
          isBooleanType(member) ||
          member.kind === ts.SyntaxKind.UndefinedKeyword ||
          (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
      )
    );
  }
  return false;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function getThisPropertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
function resolveThisProperty(expression: ts.Expression, visited: Set<ts.Node>): boolean {
  const propName = getThisPropertyName(expression);
  if (!propName) {
    return false;
  }
  let parent: ts.Node | undefined = expression.parent;
  while (parent && !ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) {
    parent = parent.parent;
  }
  if (!parent) {
    return false;
  }
  for (const member of parent.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      member.name &&
      ts.isIdentifier(member.name) &&
      member.name.text === propName
    ) {
      if (visited.has(member)) {
        return false;
      }
      visited.add(member);
      if (isBooleanType(member.type)) {
        return true;
      }
      if (member.initializer && isBooleanExpression(member.initializer, visited)) {
        return true;
      }
    }
  }
  return false;
}

// messcript-disable-next-line CyclomaticComplexity NPathComplexity
export function isBooleanExpression(
  expression: ts.Expression,
  visited: Set<ts.Node> = new Set(),
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isBooleanExpression(expression.expression, visited);
  }
  if (ts.isNonNullExpression(expression)) {
    return isBooleanExpression(expression.expression, visited);
  }
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
    return isBooleanExpression(expression.whenTrue, visited) && isBooleanExpression(expression.whenFalse, visited);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return (
      isBooleanType(expression.type) ||
      (ts.isConstTypeReference(expression.type) && isBooleanExpression(expression.expression, visited))
    );
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text === "Boolean";
  }
  if (resolveThisProperty(expression, visited)) {
    return true;
  }
  return false;
}
