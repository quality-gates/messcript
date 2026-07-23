// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { forEachFunctionLike, getFunctionContext } from "../ast/functions";
import { collectBooleanReturns, getFunctionBindingName, getNameWithoutSigil } from "../ast/names";
import type { Finding } from "../finding";
import { isBooleanExpression, isBooleanType } from "../metrics/boolean";
import { createNamingFinding } from "./naming-finding";
import { isBooleanFunction } from "./naming-utils";

export const ruleName = "BooleanGetMethodName";
export const priority = 4;
export const properties = { checkParameterizedMethods: false } as const;

export function findBooleanGetMethodName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunctionLike(sourceFile, (node) => {
    const name = getFunctionBindingName(node, sourceFile);
    if (!name || !/^get/i.test(getNameWithoutSigil(name)) || node.body === undefined) {
      return;
    }
    if (properties.checkParameterizedMethods && node.parameters.length > 0) {
      return;
    }
    if (!isBooleanFunction(node, collectBooleanReturns(node.body), isBooleanExpression, isBooleanType)) {
      return;
    }
    findings.push(
      createNamingFinding(
        node,
        sourceFile,
        ruleName,
        priority,
        getFunctionContext(node, sourceFile),
        `The '${getNameWithoutSigil(name)}()' method which returns a boolean should be named 'is...()' or 'has...()'`,
      ),
    );
  });
  return findings;
}
