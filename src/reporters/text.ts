import type { ProcessingError } from "../analyzer";
import type { Finding } from "../finding";
import { compareLocations } from "../location";

export function formatText(findings: readonly Finding[], errors: readonly ProcessingError[] = []): string {
  const entries = [
    ...findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      column: finding.column,
      text: `${finding.path}:${finding.line}:${finding.column}: ${finding.ruleName} [priority ${finding.priority}] ${finding.message} (context: ${finding.context})`,
    })),
    ...errors.map((error) => ({
      path: error.path,
      line: error.line,
      column: error.column,
      text: `${error.path}:${error.line}:${error.column}: ProcessingError ${error.message}`,
    })),
  ].sort(
    (left, right) =>
      compareLocations(left, right) ||
      (left.text < right.text ? -1 : left.text > right.text ? 1 : 0),
  );

  if (entries.length === 0) {
    return "";
  }

  return `${entries.map((entry) => entry.text).join("\n")}\n`;
}
