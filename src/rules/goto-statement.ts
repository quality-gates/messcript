// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "GotoStatement";
export const priority = 1;
export const properties = {} as const;

/** JavaScript and TypeScript have no goto construct; keep the catalog identity inert. */
export function findGotoStatement(sourceFile: ts.SourceFile): Finding[] {
  return [];
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findGotoStatement(sourceFile),
};
