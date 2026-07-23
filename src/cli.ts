#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { analyze } from "./analyzer";
import {
  formatAnsi,
  formatGithub,
  formatGitlab,
  formatHtml,
  type ColorMode,
} from "./reporters/human";
import { formatStructured } from "./reporters/structured";
import { formatText } from "./reporters/text";
import { applyRuleFilters, loadRulesets } from "./rulesets";

const packageMetadata = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const usage = "Usage: messcript <paths> <format> <ruleset[,ruleset...]> [options]";
const requiredArguments = "<paths> <format> <ruleset[,ruleset...]>";

const valueOptions = new Set([
  "--minimum-priority",
  "--maximum-priority",
  "--report-file",
  "--reportfile",
  "--suffixes",
  "--exclude",
  "--enable",
  "--only",
  "--disable",
  "--color",
]);

const booleanOptions = new Set([
  "--ignore-tests",
  "--strict",
  "--verbose",
  "--ignore-errors-on-exit",
  "--ignore-violations-on-exit",
]);

const helpText = `${usage}

Analyze JavaScript and TypeScript source without executing it.

Options:
  -h, --help                         Show this help message
  -v, --version                      Show the package version
      --minimum-priority <priority>  Select findings at or above a priority
      --maximum-priority <priority>  Select findings at or below a priority
      --reportfile <path>             Write the report to a file
      --suffixes <list>              Override source suffixes
      --exclude <paths>              Exclude paths from discovery
      --enable <rules>               Add loaded rules
      --only <rules>                 Select only loaded rules
      --disable <rules>              Remove loaded rules
      --ignore-tests                 Exclude conventional test files
      --strict                       Include suppressed findings
      --color <auto|always|never>    Text color: auto on TTY, always, or never
      --verbose                      Include diagnostic details
      --ignore-errors-on-exit        Return success despite processing errors
      --ignore-violations-on-exit    Return success despite findings

Exit codes:
  0  Clean result or explicitly ignored result
  1  Operational error
  2  Selected violations
`;

type CliIo = {
  stdout: Writable;
  stderr: Writable;
};

type ParsedArguments = {
  showHelp: boolean;
  showVersion: boolean;
  paths?: string[];
  format?: string;
  rulesets?: string[];
  minimumPriority?: number;
  maximumPriority?: number;
  enable?: string[];
  only?: string[];
  disable?: string[];
  verbose: boolean;
  strict: boolean;
  reportFile?: string;
  color: ColorMode;
  suffixes?: string[];
  exclusions?: string[];
  ignoreTests: boolean;
  ignoreErrorsOnExit: boolean;
  ignoreViolationsOnExit: boolean;
};

class CliError extends Error {
  constructor(message: string, readonly ignoreErrorsOnExit = false) {
    super(message);
  }
}

function writeLine(stream: Writable, message: string): void {
  stream.write(`${message}\n`);
}

function splitOption(argument: string): { name: string; value?: string } {
  const separator = argument.indexOf("=");
  if (separator === -1) {
    return { name: argument };
  }

  return {
    name: argument.slice(0, separator),
    value: argument.slice(separator + 1),
  };
}

function splitNonEmpty(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function parsePriority(optionName: string, value: string): number {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    throw new CliError(`${optionName} expects a priority between 1 and 5, received '${value}'.`);
  }
  return priority;
}

function parseColor(value: string): ColorMode {
  const color = value.toLowerCase();
  if (color === "auto" || color === "always" || color === "never") {
    return color;
  }
  throw new CliError(`--color expects auto, always, or never, received '${value}'.`);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  const suffixes: string[] = [];
  const exclusions: string[] = [];
  let showHelp = false;
  let showVersion = false;
  let suffixesProvided = false;
  let ignoreTests = false;
  let ignoreErrorsOnExit = false;
  let ignoreViolationsOnExit = false;
  let verbose = false;
  let strict = false;
  let reportFile: string | undefined;
  let color: ColorMode = "auto";
  let minimumPriority: number | undefined;
  let maximumPriority: number | undefined;
  const enable: string[] = [];
  const only: string[] = [];
  const disable: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "-h" || argument === "--help") {
      showHelp = true;
      continue;
    }

    if (argument === "-v" || argument === "--version") {
      showVersion = true;
      continue;
    }

    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }

    const { name, value } = splitOption(argument);
    if (valueOptions.has(name)) {
      let optionValue = value;
      if (value === undefined) {
        if (argv[index + 1] === undefined || argv[index + 1].startsWith("-")) {
          throw new CliError(`Missing value for option: ${name}`, ignoreErrorsOnExit);
        }
        optionValue = argv[index + 1];
        index += 1;
      }
      if (optionValue === undefined) {
        throw new CliError(`Missing value for option: ${name}`, ignoreErrorsOnExit);
      }
      if (name === "--report-file" || name === "--reportfile") {
        reportFile = optionValue;
      } else if (name === "--color") {
        color = parseColor(optionValue);
      } else if (name === "--suffixes") {
        suffixesProvided = true;
        suffixes.push(...splitNonEmpty(optionValue));
      } else if (name === "--exclude") {
        exclusions.push(...splitNonEmpty(optionValue));
      } else if (name === "--minimum-priority") {
        minimumPriority = parsePriority(name, optionValue);
      } else if (name === "--maximum-priority") {
        maximumPriority = parsePriority(name, optionValue);
      } else if (name === "--enable") {
        enable.push(...splitNonEmpty(optionValue));
      } else if (name === "--only") {
        only.push(...splitNonEmpty(optionValue));
      } else if (name === "--disable") {
        disable.push(...splitNonEmpty(optionValue));
      }
      continue;
    }

    if (booleanOptions.has(name)) {
      if (value !== undefined) {
        throw new CliError(`Option does not accept a value: ${name}`, ignoreErrorsOnExit);
      }
      if (name === "--ignore-tests") {
        ignoreTests = true;
      } else if (name === "--ignore-errors-on-exit") {
        ignoreErrorsOnExit = true;
      } else if (name === "--ignore-violations-on-exit") {
        ignoreViolationsOnExit = true;
      } else if (name === "--verbose") {
        verbose = true;
      } else if (name === "--strict") {
        strict = true;
      }
      continue;
    }

    throw new CliError(`Unknown option: ${name}`, ignoreErrorsOnExit);
  }

  if (showHelp || showVersion) {
    if (positional.length > 0) {
      throw new CliError(`Unexpected positional argument: ${positional[0]}`, ignoreErrorsOnExit);
    }
    return {
      showHelp,
      showVersion,
      ignoreTests,
      ignoreErrorsOnExit,
      ignoreViolationsOnExit,
      verbose,
      strict,
      reportFile,
      color,
    };
  }

  if (positional.length < 3) {
    throw new CliError(`Missing required arguments: ${requiredArguments}`, ignoreErrorsOnExit);
  }

  if (positional.length > 3) {
    throw new CliError(`Unexpected positional argument: ${positional[3]}`, ignoreErrorsOnExit);
  }

  const paths = splitNonEmpty(positional[0]);
  const rulesets = splitNonEmpty(positional[2]);
  if (paths.length === 0) {
    throw new CliError("At least one input path is required", ignoreErrorsOnExit);
  }
  if (rulesets.length === 0) {
    throw new CliError("At least one ruleset is required", ignoreErrorsOnExit);
  }

  return {
    showHelp,
    showVersion,
    paths,
    format: positional[1],
    rulesets,
    minimumPriority,
    maximumPriority,
    enable,
    only,
    disable,
    verbose,
    strict,
    reportFile,
    color,
    suffixes: suffixesProvided ? suffixes : undefined,
    exclusions,
    ignoreTests,
    ignoreErrorsOnExit,
    ignoreViolationsOnExit,
  };
}

export function runCli(argv: readonly string[], io: CliIo): number {
  let parsedArguments: ParsedArguments | undefined;
  try {
    parsedArguments = parseArguments(argv);

    if (parsedArguments.showHelp) {
      io.stdout.write(helpText);
      return 0;
    }

    if (parsedArguments.showVersion) {
      writeLine(io.stdout, `messcript ${packageMetadata.version}`);
      return 0;
    }

    const format = parsedArguments.format?.toLowerCase();
    if (!format || !["text", "json", "xml", "checkstyle", "sarif", "html", "ansi", "github", "gitlab"].includes(format)) {
      throw new CliError(`Unknown format: ${parsedArguments.format}`);
    }

    const loadedRulesets = applyRuleFilters(
      loadRulesets(parsedArguments.rulesets ?? []),
      {
        minimumPriority: parsedArguments.minimumPriority,
        maximumPriority: parsedArguments.maximumPriority,
        enable: parsedArguments.enable,
        only: parsedArguments.only,
        disable: parsedArguments.disable,
      },
    );
    if (parsedArguments.verbose) {
      for (const warning of loadedRulesets.warnings) {
        writeLine(io.stderr, `Warning: ${warning}`);
      }
    }

    const result = analyze(parsedArguments.paths ?? [], loadedRulesets.selections, {
      suffixes: parsedArguments.suffixes,
      exclusions: parsedArguments.exclusions,
      ignoreTests: parsedArguments.ignoreTests,
      strict: parsedArguments.strict,
    });
    const useColor = parsedArguments.color === "always" ||
      (!parsedArguments.reportFile && parsedArguments.color === "auto" && Boolean((io.stdout as Writable & { isTTY?: boolean }).isTTY));
    let report: string;
    if (format === "text") {
      report = useColor ? formatAnsi(result.findings, result.errors) : formatText(result.findings, result.errors);
    } else if (format === "ansi") {
      report = formatAnsi(result.findings, result.errors);
    } else if (format === "html") {
      report = formatHtml(result.findings, result.errors);
    } else if (format === "github") {
      report = formatGithub(result.findings, result.errors);
    } else if (format === "gitlab") {
      report = formatGitlab(result.findings, result.errors);
    } else {
      report = formatStructured(format, result.findings, result.errors, {
        name: "messcript",
        version: packageMetadata.version,
      });
    }
    if (parsedArguments.reportFile) {
      writeFileSync(parsedArguments.reportFile, report, "utf8");
    } else {
      io.stdout.write(report);
    }
    if (result.errors.length > 0 && !parsedArguments.ignoreErrorsOnExit) {
      return 1;
    }
    return result.findings.length > 0 && !parsedArguments.ignoreViolationsOnExit ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown command error";
    writeLine(io.stderr, `Error: ${message}`);
    return parsedArguments?.ignoreErrorsOnExit || (error instanceof CliError && error.ignoreErrorsOnExit) ? 0 : 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
