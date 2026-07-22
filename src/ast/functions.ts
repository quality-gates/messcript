import ts from "typescript";

export type FunctionLike =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

export function isFunctionLikeWithBody(node: ts.Node): node is FunctionLike {
  return (
    (ts.isArrowFunction(node) && node.body !== undefined) ||
    (ts.isConstructorDeclaration(node) && node.body !== undefined) ||
    (ts.isFunctionDeclaration(node) && node.body !== undefined) ||
    (ts.isFunctionExpression(node) && node.body !== undefined) ||
    (ts.isGetAccessorDeclaration(node) && node.body !== undefined) ||
    (ts.isMethodDeclaration(node) && node.body !== undefined) ||
    (ts.isSetAccessorDeclaration(node) && node.body !== undefined)
  );
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

function getName(node: FunctionLike, sourceFile: ts.SourceFile): string | undefined {
  if (!node.name) {
    if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    return undefined;
  }

  return node.name.getText(sourceFile);
}

export function getFunctionContext(node: FunctionLike, sourceFile: ts.SourceFile): string {
  const name = getName(node, sourceFile);
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

