import ts from "typescript";
import { isFunctionLike } from "./functions";
import type { FunctionLike } from "./functions";

function bindingDeclares(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === text;
  }
  return name.elements.some((element) => ts.isBindingElement(element) && bindingDeclares(element.name, text));
}

function listDeclares(list: ts.Node | undefined, text: string): boolean {
  return list !== undefined && ts.isVariableDeclarationList(list) && list.declarations.some((declaration) => bindingDeclares(declaration.name, text));
}

function statementDeclares(statement: ts.Statement, text: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return listDeclares(statement.declarationList, text);
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
    return statement.name?.text === text;
  }
  return false;
}

function hoistedVarDeclares(body: ts.Node, text: string): boolean {
  let declared = false;
  function visit(node: ts.Node): void {
    if (declared || ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      declared = listDeclares(node, text);
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return declared;
}

function functionDeclares(node: FunctionLike, text: string): boolean {
  if (ts.isFunctionExpression(node) && node.name?.text === text) {
    return true;
  }
  if (node.parameters.some((parameter) => bindingDeclares(parameter.name, text))) {
    return true;
  }
  return node.body !== undefined && hoistedVarDeclares(node.body, text);
}

function statementsDeclare(statements: readonly ts.Statement[], text: string): boolean {
  return statements.some((statement) => statementDeclares(statement, text));
}

function blockDeclares(scope: ts.Node, text: string): boolean {
  if (ts.isSourceFile(scope)) {
    return statementsDeclare(scope.statements, text) || hoistedVarDeclares(scope, text);
  }
  if (ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    return statementsDeclare(scope.statements, text);
  }
  return ts.isCaseBlock(scope) && scope.clauses.some((clause) => statementsDeclare(clause.statements, text));
}

function headerDeclares(scope: ts.Node, text: string): boolean {
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    return listDeclares(scope.initializer, text);
  }
  return ts.isCatchClause(scope) && scope.variableDeclaration !== undefined && bindingDeclares(scope.variableDeclaration.name, text);
}

function scopeDeclares(scope: ts.Node, text: string): boolean {
  return (isFunctionLike(scope) && functionDeclares(scope, text)) || blockDeclares(scope, text) || headerDeclares(scope, text);
}

/**
 * Reports whether the identifier resolves to a declaration in an enclosing scope of its own file.
 * Imports are not treated as local bindings because they may re-export runtime globals.
 */
export function isLocallyBound(identifier: ts.Identifier): boolean {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (scopeDeclares(scope, identifier.text)) {
      return true;
    }
  }
  return false;
}
