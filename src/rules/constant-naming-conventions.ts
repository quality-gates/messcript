// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { collectSemanticConstants } from "../ast/names";
import type { Finding } from "../finding";
import { createNamingFinding } from "./naming-finding";
import { isConstantName } from "./naming-utils";

export const ruleName = "ConstantNamingConventions";
export const priority = 4;
export const properties = {} as const;

export function findConstantNamingConventions(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const constant of collectSemanticConstants(sourceFile)) {
    if (isConstantName(constant.name)) {
      continue;
    }
    findings.push(
      createNamingFinding(
        constant.node,
        sourceFile,
        ruleName,
        priority,
        constant.context,
        `Constant ${constant.name} should be defined in uppercase`,
      ),
    );
  }
  return findings;
}
