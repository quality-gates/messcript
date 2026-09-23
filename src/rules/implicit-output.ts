// messcript-disable ConstantNamingConventions
import type ts from "typescript";
import { collectImplicitFlows } from "../analysis/explicitness";
import { getFunctionContext } from "../ast/functions";
import type { Finding } from "../finding";
import { createDesignFinding } from "./design-finding";

export const ruleName = "ImplicitOutput";
export const priority = 3;
export const properties = { "include-this": false } as const;

export function findImplicitOutput(sourceFile: ts.SourceFile): Finding[] {
  return collectImplicitFlows(sourceFile, properties["include-this"])
    .filter((flow) => flow.kind === "output")
    .map((flow) => {
      const context = getFunctionContext(flow.functionNode, sourceFile);
      return createDesignFinding(flow.node, sourceFile, ruleName, priority, context, `The ${context} ${flow.description}, an implicit output.`);
    });
}
