import type { ProcessingError } from "../analyzer";
import type { Finding } from "../finding";
import { compareLocations } from "../location";

export type ReportTool = {
  name: string;
  version: string;
};

type FindingRecord = {
  path: string;
  line: number;
  column: number;
  ruleName: string;
  priority: number;
  message: string;
  context: string;
  suppressed: boolean;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (left, right) =>
      compareLocations(left, right) ||
      compareText(left.ruleName, right.ruleName) ||
      compareText(left.message, right.message) ||
      compareText(left.context, right.context) ||
      left.priority - right.priority,
  );
}

function sortedErrors(errors: readonly ProcessingError[]): ProcessingError[] {
  return [...errors].sort(
    (left, right) =>
      compareLocations(left, right) ||
      compareText(left.message, right.message),
  );
}

function findingRecord(finding: Finding): FindingRecord {
  return {
    path: finding.path,
    line: finding.line,
    column: finding.column,
    ruleName: finding.ruleName,
    priority: finding.priority,
    message: finding.message,
    context: finding.context,
    suppressed: finding.suppressed ?? false,
  };
}

export function formatJson(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
  tool: ReportTool,
): string {
  return `${JSON.stringify(
    {
      tool,
      findings: sortedFindings(findings).map(findingRecord),
      errors: sortedErrors(errors),
    },
    null,
    2,
  )}\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function attributes(values: Readonly<Record<string, string | number | boolean>>): string {
  return Object.entries(values)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join("");
}

export function formatXml(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
  tool: ReportTool,
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<messcript${attributes({ version: tool.version })}>`,
    `  <tool${attributes(tool)} />`,
    "  <findings>",
  ];
  for (const finding of sortedFindings(findings).map(findingRecord)) {
    lines.push(`    <finding${attributes(finding)} />`);
  }
  lines.push("  </findings>", "  <errors>");
  for (const error of sortedErrors(errors)) {
    lines.push(`    <error${attributes(error)} />`);
  }
  lines.push("  </errors>", "</messcript>");
  return `${lines.join("\n")}\n`;
}

function checkstyleError(
  line: number,
  column: number,
  message: string,
  source: string,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): string {
  return `    <error${attributes({
    line,
    column,
    severity: source === "messcript.ProcessingError" ? "error" : "warning",
    message,
    source,
    ...extra,
  })} />`;
}

export function formatCheckstyle(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
  tool: ReportTool,
): string {
  const byPath = new Map<string, string[]>();
  for (const finding of sortedFindings(findings).map(findingRecord)) {
    const entries = byPath.get(finding.path) ?? [];
    entries.push(checkstyleError(
      finding.line,
      finding.column,
      finding.message,
      `messcript.${finding.ruleName}`,
      { context: finding.context, priority: finding.priority, suppressed: finding.suppressed },
    ));
    byPath.set(finding.path, entries);
  }
  for (const error of sortedErrors(errors)) {
    const entries = byPath.get(error.path) ?? [];
    entries.push(checkstyleError(
      error.line,
      error.column,
      error.message,
      "messcript.ProcessingError",
    ));
    byPath.set(error.path, entries);
  }

  const lines = [`<checkstyle${attributes({ tool: tool.name, version: tool.version })}>`];
  for (const path of [...byPath.keys()].sort()) {
    lines.push(`  <file${attributes({ name: path })}>`, ...(byPath.get(path) ?? []), "  </file>");
  }
  lines.push("</checkstyle>");
  return `${lines.join("\n")}\n`;
}

function sarifLocation(path: string, line: number, column: number): object {
  return {
    physicalLocation: {
      artifactLocation: { uri: path },
      region: { startLine: line, startColumn: column },
    },
  };
}

export function formatSarif(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
  tool: ReportTool,
): string {
  const orderedFindings = sortedFindings(findings).map(findingRecord);
  const ruleNames = [...new Set(orderedFindings.map((finding) => finding.ruleName))].sort();
  const notifications = sortedErrors(errors).map((error) => ({
    level: "error",
    message: { text: `${error.path}:${error.line}:${error.column}: ${error.message}` },
    locations: [sarifLocation(error.path, error.line, error.column)],
  }));
  const report = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: tool.name,
          version: tool.version,
          rules: ruleNames.map((ruleId) => ({
            id: ruleId,
            shortDescription: { text: ruleId },
          })),
        },
      },
      results: orderedFindings.map((finding) => ({
        ruleId: finding.ruleName,
        level: "warning",
        message: { text: finding.message },
        locations: [sarifLocation(finding.path, finding.line, finding.column)],
        ...(finding.suppressed ? { suppressions: [{ kind: "inSource" }] } : {}),
        properties: {
          priority: finding.priority,
          context: finding.context,
          suppressed: finding.suppressed,
        },
      })),
      invocations: [{
        executionSuccessful: errors.length === 0,
        ...(notifications.length > 0 ? { toolExecutionNotifications: notifications } : {}),
      }],
    }],
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatStructured(
  format: string,
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
  tool: ReportTool,
): string {
  switch (format.toLowerCase()) {
    case "json":
      return formatJson(findings, errors, tool);
    case "xml":
      return formatXml(findings, errors, tool);
    case "checkstyle":
      return formatCheckstyle(findings, errors, tool);
    case "sarif":
      return formatSarif(findings, errors, tool);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}
