// messcript-disable ConstantNamingConventions
import ts from "typescript";
import type { Finding } from "../finding";
import { createDesignFinding, createDesignFindingAt, functionContextFor } from "./design-finding";

export const ruleName = "DevelopmentCodeFragment";
export const priority = 2;
export const properties = { "unwanted-functions": "", markers: "TODO,FIXME,HACK" } as const;

const defaultFunctions = new Set(["console.log", "console.debug", "debug.log", "debug.debug"]);

function callName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const parent = callName(node.expression);
    return parent ? `${parent}.${node.name.text}` : undefined;
  }
  return undefined;
}

function configuredFunctions(value: string): Set<string> {
  return new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
}

// Tracks template-expression nesting depth while scanning, and re-scans after
// each interpolation's closing brace so the scanner recovers the token stream
// instead of swallowing everything up to the next backtick (or EOF) into a
// single template token. See src/suppressions.ts for the same scanner quirk.
function trackTemplateExpression(scanner: ts.Scanner, token: ts.SyntaxKind, depths: number[]): ts.SyntaxKind {
  if (token === ts.SyntaxKind.TemplateHead) {
    depths.push(1);
    return token;
  }
  if (depths.length === 0) {
    return token;
  }
  if (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) {
    const rescanned = scanner.reScanSlashToken();
    if (rescanned === ts.SyntaxKind.RegularExpressionLiteral) {
      return rescanned;
    }
  }
  const depth = depths.length - 1;
  if (token === ts.SyntaxKind.OpenBraceToken) {
    depths[depth] += 1;
    return token;
  }
  if (token !== ts.SyntaxKind.CloseBraceToken) {
    return token;
  }
  depths[depth] -= 1;
  if (depths[depth] !== 0) {
    return token;
  }
  depths.pop();
  const rescanned = scanner.reScanTemplateToken(false);
  if (rescanned === ts.SyntaxKind.TemplateMiddle) {
    depths.push(1);
  }
  return rescanned;
}

function commentFindings(sourceFile: ts.SourceFile, markers: readonly string[]): Finding[] {
  if (markers.length === 0) {
    return [];
  }
  const findings: Finding[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, sourceFile.text);
  const templateExpressionDepths: number[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const text = scanner.getTokenText().toLowerCase();
      const marker = markers.find((candidate) => text.includes(candidate.toLowerCase()));
      if (marker) {
        findings.push(
          createDesignFindingAt(
            sourceFile,
            scanner.getTokenPos(),
            ruleName,
            priority,
            "module",
            "Development-only marker found in production source.",
          ),
        );
      }
    }
    token = trackTemplateExpression(scanner, token, templateExpressionDepths);
    token = scanner.scan();
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
