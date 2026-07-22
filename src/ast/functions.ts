import ts from "typescript";

export type FunctionLike =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

export function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

export function isFunctionLikeWithBody(node: ts.Node): node is FunctionLike {
  return isFunctionLike(node) && node.body !== undefined;
}

export function forEachFunctionLike(sourceFile: ts.SourceFile, callback: (node: FunctionLike) => void): void {
  function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      callback(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function forEachFunction(sourceFile: ts.SourceFile, callback: (node: FunctionLike) => void): void {
  function visit(node: ts.Node): void {
    if (isFunctionLikeWithBody(node)) {
      callback(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function getFunctionName(node: FunctionLike, sourceFile: ts.SourceFile): string | undefined {
  if (!node.name) {
    if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    return undefined;
  }

  return node.name.getText(sourceFile);
}

export function getFunctionContext(node: FunctionLike, sourceFile: ts.SourceFile): string {
  const name = getFunctionName(node, sourceFile);
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (ts.isMethodDeclaration(node)) {
    return `method ${name ?? "anonymous"}()`;
  }
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return `accessor ${name ?? "anonymous"}()`;
  }
  if (ts.isArrowFunction(node)) {
    return `arrow function ${name ?? "anonymous"}()`;
  }
  return `function ${name ?? "anonymous"}()`;
}
