import ts from "typescript";
import { collectBindings } from "../ast/names";
import type { Finding } from "../finding";
import { adjustedLength } from "./naming-utils";
import { createNamingFinding } from "./naming-finding";
import { isReactComponentBinding } from "./naming-utils";

export const ruleName = "LongVariable";
export const priority = 3;
export const properties = { maximum: 20, "subtract-prefixes": "", "subtract-suffixes": "" } as const;

export function findLongVariable(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const binding of collectBindings(sourceFile)) {
    if (isReactComponentBinding(binding) || adjustedLength(binding.name) <= properties.maximum) {
      continue;
    }
    findings.push(
      createNamingFinding(
        binding.node,
        sourceFile,
        ruleName,
        priority,
        binding.context,
        `Avoid excessively long variable names like ${binding.name}. Keep variable name length under ${properties.maximum}.`,
      ),
    );
  }
  return findings;
}
