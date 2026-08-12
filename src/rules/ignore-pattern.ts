// messcript-disable ConstantNamingConventions
import { spawnSync } from "node:child_process";

export const maxIgnorePatternLength = 256;
export const maxIgnoreSubjectLength = 256;

/** Probe subjects that force catastrophic backtracking on common ReDoS shapes. */
const safetyProbes = [
  `${"a".repeat(48)}!`,
  "a".repeat(48),
  `${"ab".repeat(24)}!`,
  `${"a".repeat(32)}${"b".repeat(32)}!`,
] as const;

const safetyTimeoutMs = 80;

export class IgnorePatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgnorePatternError";
  }
}

type CacheEntry = { readonly regex: RegExp } | { readonly error: IgnorePatternError };

const compileCache = new Map<string, CacheEntry>();

function asIgnorePatternError(message: string): IgnorePatternError {
  return new IgnorePatternError(message);
}

function syntaxErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid regular expression";
}

/**
 * Reject patterns that take too long against fixed adversarial probes.
 * Runs in a child process so a pathological pattern cannot hang this process.
 */
function assertPatternIsCheap(pattern: string): void {
  const script = `
const pattern = ${JSON.stringify(pattern)};
const probes = ${JSON.stringify([...safetyProbes])};
try {
  const regex = new RegExp(pattern);
  for (const probe of probes) {
    regex.test(probe);
  }
  process.exit(0);
} catch {
  process.exit(2);
}
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: safetyTimeoutMs,
  });

  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    throw asIgnorePatternError(
      "ignorepattern is too expensive to evaluate (possible ReDoS).",
    );
  }
  if (result.signal === "SIGTERM" || result.status === null) {
    throw asIgnorePatternError(
      "ignorepattern is too expensive to evaluate (possible ReDoS).",
    );
  }
  if (result.status === 2) {
    throw asIgnorePatternError(`Invalid ignorepattern: ${pattern}`);
  }
  if (result.status !== 0) {
    throw asIgnorePatternError(
      `ignorepattern failed safety evaluation with exit status ${String(result.status)}.`,
    );
  }
}

function compileUncached(pattern: string): RegExp {
  if (pattern.length > maxIgnorePatternLength) {
    throw asIgnorePatternError(
      `ignorepattern exceeds maximum length of ${maxIgnorePatternLength}.`,
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw asIgnorePatternError(`Invalid ignorepattern: ${syntaxErrorMessage(error)}`);
  }

  assertPatternIsCheap(pattern);
  return regex;
}

/**
 * Compile a ruleset ignorepattern.
 * Empty string means "no ignore". Invalid or expensive patterns throw IgnorePatternError.
 */
export function compileIgnorePattern(pattern: string): RegExp | undefined {
  if (pattern.length === 0) {
    return undefined;
  }

  const cached = compileCache.get(pattern);
  if (cached) {
    if ("error" in cached) {
      throw cached.error;
    }
    return cached.regex;
  }

  try {
    const regex = compileUncached(pattern);
    compileCache.set(pattern, { regex });
    return regex;
  } catch (error) {
    const ignoreError = error instanceof IgnorePatternError
      ? error
      : asIgnorePatternError(syntaxErrorMessage(error));
    compileCache.set(pattern, { error: ignoreError });
    throw ignoreError;
  }
}

/** Test a name against a compiled ignorepattern, with a hard subject-length cap. */
export function testIgnorePattern(regex: RegExp | undefined, name: string): boolean {
  if (!regex) {
    return false;
  }
  const subject = name.length > maxIgnoreSubjectLength
    ? name.slice(0, maxIgnoreSubjectLength)
    : name;
  return regex.test(subject);
}

/** True when the property name configures a method-name ignore regex. */
export function isIgnorePatternProperty(propertyName: string): boolean {
  return propertyName.trim().toLowerCase() === "ignorepattern";
}

/**
 * Validate ignorepattern configuration before analysis.
 * No-op for empty values. Throws IgnorePatternError for bad patterns.
 */
export function validateIgnorePatternProperty(propertyName: string, value: string): void {
  if (!isIgnorePatternProperty(propertyName)) {
    return;
  }
  compileIgnorePattern(value);
}
