import ts from "typescript";
import { analyzeUnused } from "../analysis/unused";
import type { Finding } from "../finding";
import { createUnusedFinding, unusedOfKind } from "./unused-finding";

export const ruleName = "UnusedPrivateMethod";
export const priority = 3;
export const properties = {} as const;

export function findUnusedPrivateMethod(sourceFile: ts.SourceFile, declarations = analyzeUnused(sourceFile)): Finding[] {
  return unusedOfKind(declarations, "privateMethod").map((declaration) =>
    createUnusedFinding(declaration, sourceFile, ruleName, `Avoid unused private methods such as '${declaration.name}'.`),
  );
}
