import ts from "typescript";
import { analyzeUnused } from "../analysis/unused";
import type { Finding } from "../finding";
import { createUnusedFinding, unusedOfKind } from "./unused-finding";

export const ruleName = "UnusedLocalVariable";
export const priority = 3;
export const properties = { "allow-unused-foreach-variables": false, exceptions: "" } as const;

export function findUnusedLocalVariable(sourceFile: ts.SourceFile, declarations = analyzeUnused(sourceFile)): Finding[] {
  const exceptions = new Set(properties.exceptions.split(",").filter(Boolean));
  return unusedOfKind(declarations, "local")
    .filter((declaration) => !exceptions.has(declaration.name))
    .map((declaration) =>
      createUnusedFinding(declaration, sourceFile, ruleName, `Avoid unused local variables such as '${declaration.name}'.`),
    );
}
