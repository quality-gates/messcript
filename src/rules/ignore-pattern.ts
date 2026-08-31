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

/** Budget for probe-only regex evaluation time, as self-reported by the child process. */
const safetyTimeoutMs = 80;

/**
 * Wall-clock backstop for the whole child process (interpreter boot + probe
 * evaluation). This is intentionally generous: it exists only to bound truly
 * runaway patterns (catastrophic backtracking that never returns), not to
 * budget the pattern itself. Boot/spawn jitter under system load must not
 * approach this value for it to remain a pure backstop rather than a source
 * of false rejections.
 */
const safetyHardTimeoutMs = 3000;

const nativeProbeEnvironmentVariable = "MESSCRIPT_NATIVE_EXECUTABLE";
export const nativeIgnorePatternProbeArgument = "--messcript-internal-ignore-pattern-probe";

export class IgnorePatternError extends Error {
  /**
   * True when this error reflects a transient evaluation condition (e.g. a
   * safety-check timeout that may have been caused by system load) rather
   * than a permanent property of the pattern itself (e.g. a syntax error).
   * Transient errors must not be cached indefinitely: the pattern deserves
   * a fresh evaluation on a later lookup.
   */
  readonly transient: boolean;

  constructor(message: string, options?: { readonly transient?: boolean }) {
    super(message);
    this.name = "IgnorePatternError";
    this.transient = options?.transient ?? false;
  }
}

type CacheEntry = { readonly regex: RegExp } | { readonly error: IgnorePatternError };

const compileCache = new Map<string, CacheEntry>();

function syntaxErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid regular expression";
}

function isTimedOut(result: ReturnType<typeof spawnSync>): boolean {
  return (
    result.status === null ||
    result.signal === "SIGTERM" ||
    Boolean(result.error && "code" in result.error && result.error.code === "ETIMEDOUT")
  );
}

/** Run the isolated regex work. Used directly by the native executable's child mode. */
export function measureIgnorePatternProbe(pattern: string): number {
  const start = process.hrtime.bigint();
  const regex = new RegExp(pattern);
  for (const probe of safetyProbes) {
    regex.test(probe);
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Select the child-process contract for Node scripts versus native SEA executables. */
export function ignorePatternProbeChildArguments(pattern: string, nodeScript: string): string[] {
  return process.env[nativeProbeEnvironmentVariable] === process.execPath
    ? [nativeIgnorePatternProbeArgument, pattern]
    : ["-e", nodeScript];
}

/**
 * Reject patterns that take too long against fixed adversarial probes.
 * Runs in a child process so a pathological pattern cannot hang this process.
 *
 * The child self-times only the regex-construction-and-probe-evaluation
 * work (via `process.hrtime.bigint()`) and reports that figure back over
 * stdout; that figure, not the parent's wall-clock observation of the
 * whole child lifetime, is what gets compared against `safetyTimeoutMs`.
 * This deliberately excludes Node interpreter startup and process-spawn
 * overhead from the budget, since those are machine/load-dependent and
 * unrelated to the cost of the pattern itself. `safetyHardTimeoutMs` is
 * a separate, generous wall-clock backstop that only fires for patterns
 * pathological enough to never return (catastrophic backtracking), not
 * for ordinary spawn jitter.
 */
function assertPatternIsCheap(pattern: string): void {
  const script = `
const start = process.hrtime.bigint();
const pattern = ${JSON.stringify(pattern)};
const probes = ${JSON.stringify([...safetyProbes])};
try {
  const regex = new RegExp(pattern);
  for (const probe of probes) {
    regex.test(probe);
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  process.stdout.write(String(elapsedMs));
  process.exit(0);
} catch {
  process.exit(2);
}
`;
  const result = spawnSync(process.execPath, ignorePatternProbeChildArguments(pattern, script), {
    encoding: "utf8",
    timeout: safetyHardTimeoutMs,
  });

  if (isTimedOut(result)) {
    throw new IgnorePatternError(
      "ignorepattern is too expensive to evaluate (possible ReDoS).",
      { transient: true },
    );
  }
  if (result.status !== 0) {
    throw new IgnorePatternError(
      result.status === 2
        ? `Invalid ignorepattern: ${pattern}`
        : `ignorepattern failed safety evaluation with exit status ${String(result.status)}.`,
    );
  }

  const probeElapsedMs = Number(result.stdout);
  if (!Number.isFinite(probeElapsedMs) || probeElapsedMs > safetyTimeoutMs) {
    throw new IgnorePatternError(
      "ignorepattern is too expensive to evaluate (possible ReDoS).",
      { transient: true },
    );
  }
}

function compileUncached(pattern: string, assertCheap: (pattern: string) => void): RegExp {
  if (pattern.length > maxIgnorePatternLength) {
    throw new IgnorePatternError(
      `ignorepattern exceeds maximum length of ${maxIgnorePatternLength}.`,
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new IgnorePatternError(`Invalid ignorepattern: ${syntaxErrorMessage(error)}`);
  }

  assertCheap(pattern);
  return regex;
}

/**
 * Compile a ruleset ignorepattern.
 * Empty string means "no ignore". Invalid or expensive patterns throw IgnorePatternError.
 *
 * `assertCheap` is an injection seam for tests; production callers should
 * never pass it and get the real ReDoS safety check.
 *
 * Permanent errors (e.g. genuine syntax errors) are cached indefinitely,
 * so a pattern that can never succeed is not re-evaluated on every lookup.
 * Transient errors (a safety-check timeout, which can be caused by
 * incidental system load rather than the pattern itself) are deliberately
 * NOT cached: a later lookup for the same pattern re-attempts compilation
 * instead of being permanently rejected based on one unlucky evaluation.
 */
export function compileIgnorePattern(
  pattern: string,
  assertCheap: (pattern: string) => void = assertPatternIsCheap,
): RegExp | undefined {
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
    const regex = compileUncached(pattern, assertCheap);
    compileCache.set(pattern, { regex });
    return regex;
  } catch (error) {
    const ignoreError = error instanceof IgnorePatternError
      ? error
      : new IgnorePatternError(syntaxErrorMessage(error));
    if (!ignoreError.transient) {
      compileCache.set(pattern, { error: ignoreError });
    }
    throw ignoreError;
  }
}

/** Test a name against a compiled ignorepattern, with a hard subject-length cap. */
export function testIgnorePattern(regex: RegExp | undefined, name: string): boolean {
  if (!regex) {
    return false;
  }
  if (name.length <= maxIgnoreSubjectLength) {
    return regex.test(name);
  }
  return regex.test(name.slice(0, maxIgnoreSubjectLength));
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
