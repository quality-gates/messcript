import type { Finding } from "../finding";

export function formatText(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return "";
  }

  return `${findings
    .map(
      (finding) =>
        `${finding.path}:${finding.line}:${finding.column}: ${finding.ruleName} [priority ${finding.priority}] ${finding.message} (context: ${finding.context})`,
    )
    .join("\n")}\n`;
}

