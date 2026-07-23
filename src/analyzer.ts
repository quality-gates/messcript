// messcript-disable CouplingBetweenObjects
import { readFileSync } from "node:fs";
import ts from "typescript";
import { discoverSourceFiles, scriptKindForPath } from "./discovery";
import type { DiscoveryOptions } from "./discovery";
import type { Finding } from "./finding";
import { compareLocations } from "./location";
import { getRuleDefinition, runGlobalVariable, runRule } from "./rules/catalog";
import type { RuleSelection } from "./rules/catalog";
import { loadRulesets } from "./rulesets";
import { applySuppressions } from "./suppressions";

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

export type AnalysisRules = readonly string[] | readonly RuleSelection[];

export type AnalyzeOptions = DiscoveryOptions & {
  strict?: boolean;
};

// messcript-disable-next-line CyclomaticComplexity ExcessiveMethodLength NPathComplexity
export function analyze(
  inputPaths: readonly string[],
  rulesets: AnalysisRules,
  discoveryOptions: AnalyzeOptions = {},
): AnalysisResult {
  const selectedRules: readonly RuleSelection[] = rulesets.length === 0
    ? []
    : typeof rulesets[0] === "string"
      ? loadRulesets(rulesets as readonly string[]).selections
      : rulesets as readonly RuleSelection[];
  // messcript-disable-next-line UnusedLocalVariable
  for (const selection of selectedRules) {
    if (!getRuleDefinition(selection.name)) {
      throw new Error(`Unknown rule: ${selection.name}`);
    }
  }

  const findings: Finding[] = [];
  const parsedSourceFiles: ts.SourceFile[] = [];
  const discovered = discoverSourceFiles(inputPaths, discoveryOptions);
  const errors: ProcessingError[] = discovered.errors.map((error) => ({
    path: error.path,
    line: 1,
    column: 1,
    message: error.message,
  }));
  // messcript-disable-next-line UnusedLocalVariable
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
      parsedSourceFiles.push(sourceFile);
      for (const selection of selectedRules) {
        if (selection.name.toLowerCase() === "globalvariable") {
          continue;
        }
        const definition = getRuleDefinition(selection.name);
        if (definition) {
          findings.push(...runRule(definition, selection, sourceFile));
        }
      }
    } catch (error) {
      errors.push({
        path,
        line: 1,
        column: 1,
        message: `Could not process ${path}: ${error instanceof Error ? error.message : "Unknown processing error"}`,
      });
    }
  }

  for (const selection of selectedRules) {
    if (selection.name.toLowerCase() !== "globalvariable") {
      continue;
    }
    const definition = getRuleDefinition(selection.name);
    if (definition) {
      findings.push(...runGlobalVariable(definition, selection, parsedSourceFiles));
    }
  }

  const sourceFilesByPath = new Map(parsedSourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile]));
  const findingsByPath = new Map<string, Finding[]>();
  for (const finding of findings) {
    const entries = findingsByPath.get(finding.path) ?? [];
    entries.push(finding);
    findingsByPath.set(finding.path, entries);
  }
  const visibleFindings: Finding[] = [];
  for (const [path, entries] of findingsByPath) {
    const sourceFile = sourceFilesByPath.get(path);
    visibleFindings.push(
      ...(sourceFile
        ? applySuppressions(sourceFile, entries, discoveryOptions.strict ?? false)
        : entries),
    );
  }
  findings.length = 0;
  findings.push(...visibleFindings);

  findings.sort((left, right) => compareLocations(left, right) || left.ruleName.localeCompare(right.ruleName));
  errors.sort(compareLocations);
  return { findings, errors };
}
