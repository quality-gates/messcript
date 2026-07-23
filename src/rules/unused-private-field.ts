// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { analyzeUnused } from "../analysis/unused";
import type { Finding } from "../finding";
import { createUnusedFinding, unusedOfKind } from "./unused-finding";

export const ruleName = "UnusedPrivateField";
export const priority = 3;
export const properties = {} as const;

export function findUnusedPrivateField(sourceFile: ts.SourceFile, declarations = analyzeUnused(sourceFile)): Finding[] {
  return unusedOfKind(declarations, "privateField").map((declaration) =>
    createUnusedFinding(declaration, sourceFile, ruleName, `Avoid unused private fields such as '${declaration.name}'.`),
  );
}
