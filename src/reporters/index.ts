// messcript-disable CouplingBetweenObjects
// messcript-disable ConstantNamingConventions

import type { ProcessingError } from "../analyzer";
import type { Finding } from "../finding";
import { formatAnsi, formatGithub, formatGitlab, formatHtml } from "./human";
import { formatCheckstyle, formatJson, formatSarif, formatXml, type ReportTool } from "./serializers";
import { formatText } from "./text";

export type ReportOptions = {
  color: boolean;
  tool: ReportTool;
};

export type ReportResult = {
  findings: readonly Finding[];
  errors: readonly ProcessingError[];
};

type Reporter = {
  structured: boolean;
  render: (result: ReportResult, options: ReportOptions) => string;
};

const reporters: Readonly<Record<string, Reporter>> = {
  text: {
    structured: false,
    render: ({ findings, errors }, { color }) => color ? formatAnsi(findings, errors) : formatText(findings, errors),
  },
  json: { structured: true, render: ({ findings, errors }, { tool }) => formatJson(findings, errors, tool) },
  xml: { structured: true, render: ({ findings, errors }, { tool }) => formatXml(findings, errors, tool) },
  checkstyle: { structured: true, render: ({ findings, errors }, { tool }) => formatCheckstyle(findings, errors, tool) },
  sarif: { structured: true, render: ({ findings, errors }, { tool }) => formatSarif(findings, errors, tool) },
  html: { structured: false, render: ({ findings, errors }) => formatHtml(findings, errors) },
  ansi: { structured: false, render: ({ findings, errors }) => formatAnsi(findings, errors) },
  github: { structured: false, render: ({ findings, errors }) => formatGithub(findings, errors) },
  gitlab: { structured: false, render: ({ findings, errors }) => formatGitlab(findings, errors) },
};

export const reportFormats: readonly string[] = Object.freeze(Object.keys(reporters));

function reporterFor(format: string): Reporter {
  const name = format.toLowerCase();
  if (!Object.hasOwn(reporters, name)) {
    throw new Error(`Unknown format: ${format}`);
  }
  return reporters[name];
}

export function formatReport(format: string, result: ReportResult, options: ReportOptions): string {
  return reporterFor(format).render(result, options);
}

export function formatStructured(
  format: string,
  findings: readonly Finding[],
  errors: readonly ProcessingError[],
  tool: ReportTool,
): string {
  const reporter = reporterFor(format);
  if (!reporter.structured) {
    throw new Error(`Unknown format: ${format}`);
  }
  return reporter.render({ findings, errors }, { color: false, tool });
}
