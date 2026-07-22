import { readFileSync } from "node:fs";
import ts from "typescript";
import { discoverSourceFiles, scriptKindForPath } from "./discovery";
import type { Finding } from "./finding";
import { findCyclomaticComplexity } from "./rules/cyclomatic-complexity";

export function analyze(inputPaths: readonly string[], rulesets: readonly string[]): Finding[] {
  const normalizedRulesets = [...new Set(rulesets.map((ruleset) => ruleset.toLowerCase()))];
  for (const ruleset of normalizedRulesets) {
    if (ruleset !== "codesize") {
      throw new Error(`Unknown ruleset: ${ruleset}`);
    }
  }

  const findings: Finding[] = [];
  for (const path of discoverSourceFiles(inputPaths)) {
    const sourceText = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (parseDiagnostics.length > 0) {
      const diagnostic = parseDiagnostics[0];
      const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      throw new Error(`Could not parse ${path}:${position.line + 1}:${position.character + 1}: ${message}`);
    }
    findings.push(...findCyclomaticComplexity(sourceFile));
  }

  return findings.sort((left, right) => {
    if (left.path !== right.path) {
      return left.path < right.path ? -1 : 1;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.column !== right.column) {
      return left.column - right.column;
    }
    return left.ruleName.localeCompare(right.ruleName);
  });
}
