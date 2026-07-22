import ts from "typescript";
import type { Finding } from "../finding";

export const ruleName = "CyclomaticComplexity";
export const priority = 3;
export const reportLevel = 10;

type FunctionLike =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLikeWithBody(node: ts.Node): node is FunctionLike {
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

function hasOptionalChain(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node) && !ts.isCallExpression(node)) {
    return false;
  }

  return (node as ts.Node & { questionDotToken?: ts.QuestionDotToken }).questionDotToken !== undefined;
}

function isDecisionOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

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

function getName(node: FunctionLike, sourceFile: ts.SourceFile): string | undefined {
  if (!node.name) {
    if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    return undefined;
  }

  return node.name.getText(sourceFile);
}

function getContext(node: FunctionLike, sourceFile: ts.SourceFile): string {
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

function createCyclomaticComplexityFinding(
  node: FunctionLike,
  sourceFile: ts.SourceFile,
  complexity: number,
): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const context = getContext(node, sourceFile);

  return {
    path: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    ruleName,
    priority,
    context,
    message: `The ${context} has a Cyclomatic Complexity of ${complexity}. The configured cyclomatic complexity threshold is ${reportLevel}.`,
  };
}

export function findCyclomaticComplexity(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLikeWithBody(node)) {
      const body = node.body;
      if (body) {
        const complexity = countDecisionPoints(body);
        if (complexity > reportLevel) {
          findings.push(createCyclomaticComplexityFinding(node, sourceFile, complexity));
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}
