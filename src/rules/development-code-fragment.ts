// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { sourceComments } from "../ast/source-comments";
import type { Finding } from "../finding";
import { createDesignFinding, createDesignFindingAt, functionContextFor } from "./design-finding";

export const ruleName = "DevelopmentCodeFragment";
export const priority = 2;
export const properties = { "unwanted-functions": "", markers: "TODO,FIXME,HACK" } as const;

const defaultFunctions = new Set(["console.log", "console.debug", "debug.log", "debug.debug"]);

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function callName(node: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(node);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const parent = callName(unwrapped.expression);
    return parent ? `${parent}.${unwrapped.name.text}` : undefined;
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const argument = unwrapExpression(unwrapped.argumentExpression);
    if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) {
      return undefined;
    }
    const parent = callName(unwrapped.expression);
    return parent ? `${parent}.${argument.text}` : undefined;
  }
  return undefined;
}

function configuredFunctions(value: string): Set<string> {
  return new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
}

function commentFindings(sourceFile: ts.SourceFile, markers: readonly string[]): Finding[] {
  if (markers.length === 0) {
    return [];
  }
  const findings: Finding[] = [];
  for (const comment of sourceComments(sourceFile)) {
    const text = comment.text.toLowerCase();
    const marker = markers.find((candidate) => text.includes(candidate.toLowerCase()));
    if (marker) {
      findings.push(
        createDesignFindingAt(
          sourceFile,
          comment.pos,
          ruleName,
          priority,
          "module",
          "Development-only marker found in production source.",
        ),
      );
    }
  }
  return findings;
}

export function findDevelopmentCodeFragment(
  sourceFile: ts.SourceFile,
  unwantedFunctions = properties["unwanted-functions"],
  markers = properties.markers,
): Finding[] {
  const findings = commentFindings(
    sourceFile,
    markers.split(",").map((marker) => marker.trim()).filter(Boolean),
  );
  const unwanted = new Set([...defaultFunctions, ...configuredFunctions(unwantedFunctions)]);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name && unwanted.has(name.toLowerCase())) {
        const context = functionContextFor(node, sourceFile);
        const message = context === "module"
          ? `The module calls the typical debug function ${name}() which is mostly only used during development.`
          : `The ${context} calls the typical debug function ${name}() which is mostly only used during development.`;
        findings.push(createDesignFinding(node, sourceFile, ruleName, priority, context, message));
      }
    }
    if (ts.isDebuggerStatement(node)) {
      const context = functionContextFor(node, sourceFile);
      findings.push(
        createDesignFinding(
          node,
          sourceFile,
          ruleName,
          priority,
          context,
          context === "module"
            ? "The module contains a debugger statement which is mostly only used during development."
            : `The ${context} contains a debugger statement which is mostly only used during development.`,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}
