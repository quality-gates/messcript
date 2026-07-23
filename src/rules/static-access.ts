// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { Finding } from "../finding";
import { className, createCleanCodeFinding, enclosingClass, functionContext, functionName } from "./clean-code-finding";

export const ruleName = "StaticAccess";
export const priority = 1;
export const properties = { exceptions: "", ignorepattern: "" } as const;

function exceptionNames(): Set<string> {
  return new Set(properties.exceptions.split(",").map((value) => value.trim()).filter(Boolean));
}

function isIgnoredMethod(name: string): boolean {
  return properties.ignorepattern.length > 0 && new RegExp(properties.ignorepattern).test(name);
}

export function findStaticAccess(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const exceptions = exceptionNames();
  forEachFunction(sourceFile, (node) => {
    const methodName = functionName(node, sourceFile);
    if (isIgnoredMethod(methodName)) {
      return;
    }
    const ownClass = enclosingClass(node);
    const ownClassName = ownClass ? className(ownClass) : undefined;
    function visit(bodyNode: ts.Node): void {
      if (bodyNode !== node.body && ts.isFunctionLike(bodyNode)) {
        return;
      }
      if (ts.isCallExpression(bodyNode) && ts.isPropertyAccessExpression(bodyNode.expression)) {
        const receiver = bodyNode.expression.expression;
        if (ts.isIdentifier(receiver) && /^[A-Z]/.test(receiver.text) && receiver.text !== ownClassName && !exceptions.has(receiver.text)) {
          findings.push(
            createCleanCodeFinding(
              bodyNode,
              sourceFile,
              ruleName,
              priority,
              functionContext(node, sourceFile),
              `Avoid using static access to class '${receiver.text}' in method '${methodName}'.`,
            ),
          );
        }
      }
      ts.forEachChild(bodyNode, visit);
    }
    if (node.body) {
      visit(node.body);
    }
  });
  return findings;
}
