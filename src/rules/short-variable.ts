import ts from "typescript";
import { collectBindings } from "../ast/names";
import type { Finding } from "../finding";
import { createNamingFinding } from "./naming-finding";
import { isIdiomaticShortName, isReactComponentBinding } from "./naming-utils";

export const ruleName = "ShortVariable";
export const priority = 3;
export const properties = { minimum: 3, exceptions: "" } as const;

export function findShortVariable(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const binding of collectBindings(sourceFile)) {
    if (
      binding.name.length >= properties.minimum ||
      isIdiomaticShortName(binding.name) ||
      isReactComponentBinding(binding) ||
      properties.exceptions.split(",").includes(binding.name)
    ) {
      continue;
    }
    findings.push(
      createNamingFinding(
        binding.node,
        sourceFile,
        ruleName,
        priority,
        binding.context,
        `Avoid variables with short names like ${binding.name}. Configured minimum length is ${properties.minimum}.`,
      ),
    );
  }
  return findings;
}
