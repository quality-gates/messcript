// messcript-disable ConstantNamingConventions
import type ts from "typescript";
import { collectImplicitFlows } from "../analysis/explicitness";
import { ownerContext, ownerSubject } from "../analysis/owners";
import type { Finding } from "../finding";
import { createDesignFinding } from "./design-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "UnknownEffect";
export const priority = 3;
export const properties = { "include-this": false } as const;

export function findUnknownEffect(sourceFile: ts.SourceFile): Finding[] {
  return collectImplicitFlows(sourceFile, properties["include-this"])
    .filter((flow) => flow.kind === "unknown")
    .map((flow) => {
      const context = ownerContext(flow.owner, sourceFile);
      const subject = ownerSubject(flow.owner, sourceFile);
      return createDesignFinding(flow.node, sourceFile, ruleName, priority, context, `The ${subject} ${flow.description}, an unknown effect.`);
    });
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findUnknownEffect(sourceFile),
};
