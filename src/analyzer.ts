import { readFileSync } from "node:fs";
import ts from "typescript";
import { discoverSourceFiles, scriptKindForPath } from "./discovery";
import type { DiscoveryOptions } from "./discovery";
import type { Finding } from "./finding";
import { compareLocations } from "./location";
import { findCyclomaticComplexity } from "./rules/cyclomatic-complexity";
import { findExcessiveMethodLength } from "./rules/excessive-method-length";
import { findExcessiveParameterList } from "./rules/excessive-parameter-list";
import { findNPathComplexity } from "./rules/npath-complexity";

export type ProcessingError = {
  path: string;
  line: number;
  column: number;
  message: string;
};

export type AnalysisResult = {
  findings: Finding[];
  errors: ProcessingError[];
};

export function analyze(
  inputPaths: readonly string[],
  rulesets: readonly string[],
  discoveryOptions: DiscoveryOptions = {},
): AnalysisResult {
  const normalizedRulesets = [...new Set(rulesets.map((ruleset) => ruleset.toLowerCase()))];
  for (const ruleset of normalizedRulesets) {
    if (ruleset !== "codesize") {
      throw new Error(`Unknown ruleset: ${ruleset}`);
    }
  }

  const findings: Finding[] = [];
  const discovered = discoverSourceFiles(inputPaths, discoveryOptions);
  const errors: ProcessingError[] = discovered.errors.map((error) => ({
    path: error.path,
    line: 1,
    column: 1,
    message: error.message,
  }));
  for (const path of discovered.files) {
    try {
      const sourceText = readFileSync(path, "utf8");
      const sourceFile = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForPath(path, discoveryOptions.suffixes),
      );
      const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
      for (const diagnostic of parseDiagnostics) {
        const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
        errors.push({
          path,
          line: position.line + 1,
          column: position.character + 1,
          message: `Could not parse ${path}: ${message}`,
        });
      }
      if (parseDiagnostics.length > 0) {
        continue;
      }
      findings.push(
        ...findCyclomaticComplexity(sourceFile),
        ...findNPathComplexity(sourceFile),
        ...findExcessiveMethodLength(sourceFile),
        ...findExcessiveParameterList(sourceFile),
      );
    } catch (error) {
      errors.push({
        path,
        line: 1,
        column: 1,
        message: `Could not process ${path}: ${error instanceof Error ? error.message : "Unknown processing error"}`,
      });
    }
  }

  findings.sort((left, right) => compareLocations(left, right) || left.ruleName.localeCompare(right.ruleName));
  errors.sort(compareLocations);
  return { findings, errors };
}
