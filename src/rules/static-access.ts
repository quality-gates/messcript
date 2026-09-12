// messcript-disable ConstantNamingConventions
// messcript-disable CouplingBetweenObjects
import ts from "typescript";
import { forEachFunction } from "../ast/functions";
import type { Finding } from "../finding";
import { className, createCleanCodeFinding, enclosingClass, functionContext, functionName } from "./clean-code-finding";
import { compileIgnorePattern, testIgnorePattern } from "./ignore-pattern";

export const ruleName = "StaticAccess";
export const priority = 1;
export const properties = { exceptions: "", ignorepattern: "" } as const;

function exceptionNames(): Set<string> {
  return new Set(properties.exceptions.split(",").map((value) => value.trim()).filter(Boolean));
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isNamedAccess(node: ts.Expression): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (ts.isPropertyAccessExpression(node)) {
    return true;
  }
  if (!ts.isElementAccessExpression(node)) {
    return false;
  }
  const argument = unwrapExpression(node.argumentExpression);
  return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument);
}

export function findStaticAccess(sourceFile: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const exceptions = exceptionNames();
  const ignoreRegex = compileIgnorePattern(properties.ignorepattern);
  forEachFunction(sourceFile, (node) => {
    const methodName = functionName(node, sourceFile);
    if (testIgnorePattern(ignoreRegex, methodName)) {
      return;
    }
    const ownClass = enclosingClass(node);
    const ownClassName = ownClass ? className(ownClass) : undefined;
    function visit(bodyNode: ts.Node): void {
      if (bodyNode !== node.body && ts.isFunctionLike(bodyNode)) {
        return;
      }
      if (ts.isCallExpression(bodyNode)) {
        const callee = unwrapExpression(bodyNode.expression);
        if (isNamedAccess(callee)) {
          const receiver = unwrapExpression(callee.expression);
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
      }
      ts.forEachChild(bodyNode, visit);
    }
    if (node.body) {
      visit(node.body);
    }
  });
  return findings;
}
