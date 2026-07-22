import ts from "typescript";
import { forEachFunctionLike, getFunctionContext } from "../ast/functions";
import { getFunctionBindingName, getNameWithoutSigil, isReactComponentName } from "../ast/names";
import type { Finding } from "../finding";
import { createNamingFinding } from "./naming-finding";
import { isIdiomaticShortName } from "./naming-utils";

export const ruleName = "ShortMethodName";
export const priority = 3;
export const properties = { minimum: 3, exceptions: "" } as const;

export function findShortMethodName(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  forEachFunctionLike(sourceFile, (node) => {
    const name = getFunctionBindingName(node, sourceFile);
    if (!name || getNameWithoutSigil(name).length >= properties.minimum || isIdiomaticShortName(name) || isReactComponentName(name, node)) {
      return;
    }
    findings.push(
      createNamingFinding(
        node,
        sourceFile,
        ruleName,
        priority,
        getFunctionContext(node, sourceFile),
        `Avoid using short method names like ${name}(). The configured minimum method name length is ${properties.minimum}.`,
      ),
    );
  });
  return findings;
}
