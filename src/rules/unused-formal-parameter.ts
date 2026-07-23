// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { analyzeUnused } from "../analysis/unused";
import type { Finding } from "../finding";
import { createUnusedFinding, unusedOfKind } from "./unused-finding";

export const ruleName = "UnusedFormalParameter";
export const priority = 3;
export const properties = {} as const;

export function findUnusedFormalParameter(sourceFile: ts.SourceFile, declarations = analyzeUnused(sourceFile)): Finding[] {
  return unusedOfKind(declarations, "formal")
    .filter((declaration) => !declaration.name.startsWith("_"))
    .map((declaration) =>
      createUnusedFinding(declaration, sourceFile, ruleName, `Avoid unused parameters such as '${declaration.name}'.`),
    );
}
