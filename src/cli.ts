#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { analyze } from "./analyzer";
import { formatText } from "./reporters/text";

const packageMetadata = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const usage = "Usage: messcript <paths> <format> <ruleset[,ruleset...]> [options]";
const requiredArguments = "<paths> <format> <ruleset[,ruleset...]>";

const valueOptions = new Set([
  "--minimum-priority",
  "--maximum-priority",
  "--report-file",
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
      --report-file <path>           Write the report to a file
      --suffixes <list>              Override source suffixes
      --exclude <paths>              Exclude paths from discovery
      --enable <rules>               Add loaded rules
      --only <rules>                 Select only loaded rules
      --disable <rules>              Remove loaded rules
      --ignore-tests                 Exclude conventional test files
      --strict                       Include suppressed findings
      --color <auto|always|never>    Select terminal color behavior
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
};

class CliError extends Error {}

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
  return value.split(",").filter((part) => part.length > 0);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let showHelp = false;
  let showVersion = false;

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
      if (value === undefined) {
        if (argv[index + 1] === undefined || argv[index + 1].startsWith("-")) {
          throw new CliError(`Missing value for option: ${name}`);
        }
        index += 1;
      }
      continue;
    }

    if (booleanOptions.has(name)) {
      if (value !== undefined) {
        throw new CliError(`Option does not accept a value: ${name}`);
      }
      continue;
    }

    throw new CliError(`Unknown option: ${name}`);
  }

  if (showHelp || showVersion) {
    if (positional.length > 0) {
      throw new CliError(`Unexpected positional argument: ${positional[0]}`);
    }
    return { showHelp, showVersion };
  }

  if (positional.length < 3) {
    throw new CliError(`Missing required arguments: ${requiredArguments}`);
  }

  if (positional.length > 3) {
    throw new CliError(`Unexpected positional argument: ${positional[3]}`);
  }

  const paths = splitNonEmpty(positional[0]);
  const rulesets = splitNonEmpty(positional[2]);
  if (paths.length === 0) {
    throw new CliError("At least one input path is required");
  }
  if (rulesets.length === 0) {
    throw new CliError("At least one ruleset is required");
  }

  return { showHelp, showVersion, paths, format: positional[1], rulesets };
}

export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    const parsedArguments = parseArguments(argv);

    if (parsedArguments.showHelp) {
      io.stdout.write(helpText);
      return 0;
    }

    if (parsedArguments.showVersion) {
      writeLine(io.stdout, `messcript ${packageMetadata.version}`);
      return 0;
    }

    if (parsedArguments.format?.toLowerCase() !== "text") {
      throw new CliError(`Unknown format: ${parsedArguments.format}`);
    }

    const findings = analyze(parsedArguments.paths ?? [], parsedArguments.rulesets ?? []);
    io.stdout.write(formatText(findings));
    return findings.length > 0 ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown command error";
    writeLine(io.stderr, `Error: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
