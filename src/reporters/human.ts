import { relative, sep } from "node:path";
import type { ProcessingError } from "../analyzer";
import type { Finding } from "../finding";
import { compareLocations } from "../location";

export type ColorMode = "auto" | "always" | "never";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (left, right) =>
      compareLocations(left, right) ||
      compareText(left.ruleName, right.ruleName) ||
      compareText(left.message, right.message),
  );
}

function orderedErrors(errors: readonly ProcessingError[]): ProcessingError[] {
  return [...errors].sort(
    (left, right) => compareLocations(left, right) || compareText(left.message, right.message),
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeReportPath(path: string): string {
  const relativePath = relative(process.cwd(), path);
  const normalized = relativePath && !relativePath.startsWith("..") ? relativePath : path;
  return normalized.split(sep).join("/");
}

export function formatHtml(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
): string {
  const lines = [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"><title>messcript report</title>',
    "<style>body{font-family:system-ui,sans-serif}table{border-collapse:collapse;margin:0 0 1.5rem}th,td{border:1px solid #ccc;padding:.3rem .5rem;text-align:left}th{background:#eee}.suppressed{opacity:.65}</style>",
    "</head><body>",
    "<h1>messcript report</h1>",
  ];
  const rowsByPath = new Map<string, string[]>();
  for (const finding of orderedFindings(findings)) {
    const entries = rowsByPath.get(finding.path) ?? [];
    entries.push(`<tr${finding.suppressed ? ' class="suppressed"' : ""}><td>${finding.line}</td><td>${finding.column}</td><td>${htmlEscape(finding.ruleName)}</td><td>${finding.priority}</td><td>${htmlEscape(finding.message)}</td><td>${htmlEscape(finding.context)}</td><td>${finding.suppressed ? "suppressed" : ""}</td></tr>`);
    rowsByPath.set(finding.path, entries);
  }
  for (const path of [...rowsByPath.keys()].sort(compareText)) {
    lines.push(`<h2>${htmlEscape(normalizeReportPath(path))}</h2>`);
    lines.push("<table><tr><th>Line</th><th>Column</th><th>Rule</th><th>Priority</th><th>Message</th><th>Context</th><th>State</th></tr>");
    lines.push(...(rowsByPath.get(path) ?? []), "</table>");
  }
  if (errors.length > 0) {
    lines.push("<h2>Processing errors</h2>", "<table><tr><th>Line</th><th>Column</th><th>Path</th><th>Message</th></tr>");
    for (const error of orderedErrors(errors)) {
      lines.push(`<tr><td>${error.line}</td><td>${error.column}</td><td>${htmlEscape(normalizeReportPath(error.path))}</td><td>${htmlEscape(error.message)}</td></tr>`);
    }
    lines.push("</table>");
  }
  lines.push("</body></html>");
  return `${lines.join("\n")}\n`;
}

function ansiEscape(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function ansi(code: string, value: string): string {
  return `\x1b[${code}m${ansiEscape(value)}\x1b[0m`;
}

export function formatAnsi(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
): string {
  const lines: string[] = [];
  for (const finding of orderedFindings(findings)) {
    const state = finding.suppressed ? " [suppressed]" : "";
    lines.push(`${normalizeReportPath(finding.path)}:${finding.line}:${finding.column}: ${ansi("33", `${finding.ruleName} [priority ${finding.priority}]${state}`)} ${ansi("31", finding.message)} (context: ${ansiEscape(finding.context)})`);
  }
  for (const error of orderedErrors(errors)) {
    lines.push(`${normalizeReportPath(error.path)}:${error.line}:${error.column}: ${ansi("31", `ProcessingError ${error.message}`)}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function commandEscape(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

export function formatGithub(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
): string {
  const lines = orderedFindings(findings).map((finding) => {
    const path = commandEscape(normalizeReportPath(finding.path));
    const title = commandEscape(`${finding.ruleName} [priority ${finding.priority}]`);
    const message = commandEscape(`${finding.message} (context: ${finding.context})${finding.suppressed ? " [suppressed]" : ""}`);
    return `::warning file=${path},line=${finding.line},col=${finding.column},title=${title}::${message}`;
  });
  lines.push(...orderedErrors(errors).map((error) => {
    const path = commandEscape(normalizeReportPath(error.path));
    const message = commandEscape(error.message);
    return `::error file=${path},line=${error.line},col=${error.column},title=ProcessingError::${message}`;
  }));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function gitLabSeverity(priority: number): string {
  switch (priority) {
    case 1:
      return "blocker";
    case 2:
      return "critical";
    case 3:
      return "major";
    case 4:
      return "minor";
    default:
      return "info";
  }
}

function gitLabFingerprint(path: string, line: number, column: number, ruleName: string, message: string): string {
  return Buffer.from(`${path}:${line}:${column}:${ruleName}:${message}`, "utf8").toString("hex");
}

export function formatGitlab(
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
): string {
  const entries = orderedFindings(findings).map((finding) => {
    const path = normalizeReportPath(finding.path);
    return {
      type: "issue",
      check_name: finding.ruleName,
      description: `${finding.message} (context: ${finding.context})${finding.suppressed ? " [suppressed]" : ""}`,
      fingerprint: gitLabFingerprint(path, finding.line, finding.column, finding.ruleName, finding.message),
      severity: gitLabSeverity(finding.priority),
      location: { path, lines: { begin: finding.line } },
      priority: finding.priority,
      suppressed: finding.suppressed ?? false,
    };
  });
  entries.push(...orderedErrors(errors).map((error) => {
    const path = normalizeReportPath(error.path);
    return {
      type: "issue",
      check_name: "ProcessingError",
      description: error.message,
      fingerprint: gitLabFingerprint(path, error.line, error.column, "ProcessingError", error.message),
      severity: "blocker",
      location: { path, lines: { begin: error.line } },
      priority: 1,
      suppressed: false,
    };
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}
