// messcript-disable ConstantNamingConventions
import ts from "typescript";
import { globalReference, memberChainName } from "../ast/global-reference";
import { sourceComments } from "../ast/source-comments";
import type { Finding } from "../finding";
import { createDesignFinding, createDesignFindingAt, functionContextFor } from "./design-finding";

export const ruleName = "DevelopmentCodeFragment";
export const priority = 2;
export const properties = { "unwanted-functions": "", markers: "TODO,FIXME,HACK" } as const;

// Host globals. A local binding of the root name hides them.
const hostFunctions = new Set(["console.log", "console.debug"]);
// Names that are not host globals. They match whatever the root name is bound to.
const defaultNamedFunctions = ["debug.log", "debug.debug"];

function configuredFunctions(value: string): Set<string> {
  return new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
}

function markerPattern(markers: readonly string[]): RegExp {
  const alternatives = markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

function commentFindings(sourceFile: ts.SourceFile, markers: readonly string[]): Finding[] {
  if (markers.length === 0) {
    return [];
  }
  const pattern = markerPattern(markers);
  const findings: Finding[] = [];
  for (const comment of sourceComments(sourceFile)) {
    if (pattern.test(comment.text)) {
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

function unwantedName(callee: ts.Expression, unwanted: ReadonlySet<string>): string | undefined {
  const reference = globalReference(callee);
  if (reference && hostFunctions.has(reference.toLowerCase())) {
    return reference;
  }
  const name = memberChainName(callee);
  return name && unwanted.has(name.toLowerCase()) ? name : undefined;
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
  const unwanted = new Set([...defaultNamedFunctions, ...configuredFunctions(unwantedFunctions)]);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = unwantedName(node.expression, unwanted);
      if (name) {
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
