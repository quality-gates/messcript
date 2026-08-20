// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { analyzeUnused } from "../analysis/unused";
import type { Finding } from "../finding";
import { createUnusedFinding, unusedOfKind } from "./unused-finding";
import { parseCommaSeparatedNames } from "./naming-utils";

export const ruleName = "UnusedLocalVariable";
export const priority = 3;
export const properties = { "allow-unused-foreach-variables": false, exceptions: "" } as const;

function findVariableDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isVariableDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isForeachVariable(node: ts.Node): boolean {
  const declaration = findVariableDeclaration(node);
  if (!declaration) {
    return false;
  }
  const declarationList = declaration.parent;
  if (!ts.isVariableDeclarationList(declarationList)) {
    return false;
  }
  const loop = declarationList.parent;
  return ts.isForInStatement(loop) || ts.isForOfStatement(loop);
}

export function findUnusedLocalVariable(sourceFile: ts.SourceFile, declarations = analyzeUnused(sourceFile)): Finding[] {
  const exceptions = new Set(parseCommaSeparatedNames(properties.exceptions));
  return unusedOfKind(declarations, "local")
    .filter(
      (declaration) =>
        !exceptions.has(declaration.name) &&
        !(properties["allow-unused-foreach-variables"] && isForeachVariable(declaration.node)),
    )
    .map((declaration) =>
      createUnusedFinding(declaration, sourceFile, ruleName, `Avoid unused local variables such as '${declaration.name}'.`),
    );
}
