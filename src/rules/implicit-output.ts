// messcript-disable ConstantNamingConventions
import type ts from "typescript";
import { collectImplicitFlows } from "../analysis/explicitness";
import { ownerContext, ownerSubject } from "../analysis/owners";
import type { Finding } from "../finding";
import { createDesignFinding } from "./design-finding";
import type { RuleDefinition } from "./catalog";

export const ruleName = "ImplicitOutput";
export const priority = 3;
export const properties = { "include-this": false } as const;

export function findImplicitOutput(sourceFile: ts.SourceFile): Finding[] {
  return collectImplicitFlows(sourceFile, properties["include-this"])
    .filter((flow) => flow.kind === "output")
    .map((flow) => {
      const context = ownerContext(flow.owner, sourceFile);
      const subject = ownerSubject(flow.owner, sourceFile);
      return createDesignFinding(flow.node, sourceFile, ruleName, priority, context, `The ${subject} ${flow.description}, an implicit output.`);
    });
}

export const definition: RuleDefinition = {
  name: ruleName,
  priority,
  properties,
  run: (sourceFile) => findImplicitOutput(sourceFile),
};
