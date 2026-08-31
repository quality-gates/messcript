import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import ts from "typescript";
import { runCli } from "../dist/cli.js";
import { analyze } from "../dist/analyzer.js";
import { loadRulesets, RulesetError } from "../dist/rulesets.js";
import {
  IgnorePatternError,
  compileIgnorePattern,
  ignorePatternProbeChildArguments,
  isIgnorePatternProperty,
  maxIgnorePatternLength,
  maxIgnoreSubjectLength,
  nativeIgnorePatternProbeArgument,
  testIgnorePattern,
  validateIgnorePatternProperty,
} from "../dist/rules/ignore-pattern.js";
import { getRuleDefinition, runRule, validateSelectionProperties } from "../dist/rules/catalog.js";

let workspace;

function capture() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { stream, read: () => output };
}

function run(args) {
  const stdout = capture();
  const stderr = capture();
  const status = runCli(args, { stdout: stdout.stream, stderr: stderr.stream });
  return { status, stdout: stdout.read(), stderr: stderr.read() };
}

function runCliTimed(args, timeoutMs = 2000) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd: process.cwd(),
  });
  const elapsedMs = performance.now() - started;
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT") || result.signal === "SIGTERM";
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs,
    timedOut,
  };
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "messcript-ignore-pattern-"));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeSource(name, source) {
  const path = join(workspace, name);
  writeFileSync(path, source);
  return path;
}

function writeRuleset(name, xml) {
  const path = join(workspace, name);
  writeFileSync(path, xml);
  return path;
}

function sourceFileFrom(path) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

test("nested-quantifier ignorepattern is rejected before analysis and does not hang", () => {
  const source = writeSource(
    "redos.ts",
    `export function ${"a".repeat(30)}b(flag: boolean): boolean { return flag; }\n`,
  );
  const ruleset = writeRuleset(
    "redos.xml",
    `<ruleset name="evil">
  <rule ref="BooleanArgumentFlag">
    <properties>
      <property name="ignorepattern" value="(a+)+$"/>
    </properties>
  </rule>
</ruleset>`,
  );

  const result = runCliTimed([source, "text", ruleset], 5000);

  assert.equal(result.timedOut, false, "CLI hung on nested-quantifier ignorepattern");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too expensive|ignorepattern/i);
  assert.equal(result.stdout, "");
  assert.ok(result.elapsedMs < 5000, `expected bounded rejection, took ${result.elapsedMs.toFixed(0)}ms`);
});

test("alternation ReDoS ignorepattern is rejected before analysis and does not hang", () => {
  const source = writeSource(
    "alt-redos.ts",
    `export function ${"a".repeat(30)}b(flag: boolean): boolean { return flag; }\n`,
  );
  const ruleset = writeRuleset(
    "alt-redos.xml",
    `<ruleset name="evil">
  <rule ref="StaticAccess">
    <properties>
      <property name="ignorepattern" value="(a|a)*$"/>
    </properties>
  </rule>
</ruleset>`,
  );

  const result = runCliTimed([source, "text", ruleset], 5000);

  assert.equal(result.timedOut, false, "CLI hung on alternation ignorepattern");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too expensive|ignorepattern/i);
  assert.ok(result.elapsedMs < 5000, `expected bounded rejection, took ${result.elapsedMs.toFixed(0)}ms`);
});

test("invalid ignorepattern is a ruleset error, not a silent partial analysis", () => {
  const source = writeSource(
    "invalid-pattern.ts",
    `const deliberately_long_variable_name_for_testing = 1;
export function run(flag: boolean): number {
  try {} catch (e) {}
  if (flag = true) return 1;
  return 0;
}
`,
  );
  const ruleset = writeRuleset(
    "invalid-pattern.xml",
    `<ruleset name="broken">
  <rule ref="LongVariable">
    <properties><property name="maximum" value="10"/></properties>
  </rule>
  <rule ref="BooleanArgumentFlag">
    <properties><property name="ignorepattern" value="["/></properties>
  </rule>
  <rule ref="EmptyCatchBlock"/>
</ruleset>`,
  );

  const result = run([source, "text", ruleset]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid ignorepattern/);
  assert.match(result.stderr, /BooleanArgumentFlag/);
  assert.equal(result.stdout, "");
});

test("valid ignorepattern still suppresses matching methods via the CLI", () => {
  const source = writeSource(
    "valid-pattern.ts",
    `export function skipFlag(flag: boolean): void {}
export function keepFlag(flag: boolean): void {}
`,
  );
  const ruleset = writeRuleset(
    "valid-pattern.xml",
    `<ruleset name="ok">
  <rule ref="BooleanArgumentFlag">
    <properties><property name="ignorepattern" value="^skip"/></properties>
  </rule>
</ruleset>`,
  );

  const result = run([source, "text", ruleset]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /keepFlag/);
  assert.doesNotMatch(result.stdout, /skipFlag/);
  assert.equal(result.stderr, "");
});

test("valid StaticAccess ignorepattern suppresses matching methods via the CLI", () => {
  const source = writeSource(
    "static-access.ts",
    `export class Worker {
  ignored() { Math.max(1, 2); }
  active() { Math.max(1, 2); }
}
`,
  );
  const ruleset = writeRuleset(
    "static-access.xml",
    `<ruleset name="ok">
  <rule ref="StaticAccess">
    <properties>
      <property name="ignorepattern" value="^ignored"/>
      <property name="exceptions" value=""/>
    </properties>
  </rule>
</ruleset>`,
  );

  const result = run([source, "text", ruleset]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /active/);
  assert.doesNotMatch(result.stdout, /method 'ignored'/);
  assert.equal(result.stderr, "");
});

test("StaticAccess exceptions suppress named receivers", () => {
  const source = writeSource(
    "static-exceptions.ts",
    `export class Worker {
  run() { Logger.write(); Math.max(1, 2); }
}
`,
  );
  const ruleset = writeRuleset(
    "static-exceptions.xml",
    `<ruleset name="ok">
  <rule ref="StaticAccess">
    <properties>
      <property name="exceptions" value="Logger"/>
    </properties>
  </rule>
</ruleset>`,
  );

  const result = run([source, "text", ruleset]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Math/);
  assert.doesNotMatch(result.stdout, /Logger/);
});

test("a single rule failure does not drop findings from other rules on the same file", () => {
  const source = writeSource(
    "isolated.ts",
    `const deliberately_long_variable_name_for_testing = 1;
export function run(flag: boolean): number {
  try {} catch (e) {}
  if (flag = true) return 1;
  return 0;
}
`,
  );

  const loaded = loadRulesets(["cleancode", "naming", "design"]);
  const selections = loaded.selections.map((selection) =>
    selection.name === "BooleanArgumentFlag"
      ? {
          ...selection,
          properties: { ...selection.properties, ignorepattern: "[" },
        }
      : selection,
  );

  const result = analyze([source], selections);
  const rules = new Set(result.findings.map((finding) => finding.ruleName));
  const errorText = result.errors.map((error) => error.message).join("\n");

  assert.match(errorText, /Could not run rule BooleanArgumentFlag on /);
  assert.match(errorText, /isolated\.ts/);
  assert.match(errorText, /Invalid ignorepattern/);
  assert.ok(rules.has("LongVariable"), `expected LongVariable, got ${[...rules]}`);
  assert.ok(rules.has("EmptyCatchBlock"), `expected EmptyCatchBlock, got ${[...rules]}`);
  assert.ok(rules.has("IfStatementAssignment"), `expected IfStatementAssignment, got ${[...rules]}`);
  assert.equal(rules.has("BooleanArgumentFlag"), false);
});

test("loadRulesets rejects unsafe ignorepattern with RulesetError", () => {
  const ruleset = writeRuleset(
    "load-reject.xml",
    `<ruleset name="evil">
  <rule ref="BooleanArgumentFlag">
    <properties><property name="ignorepattern" value="(a+)+$"/></properties>
  </rule>
</ruleset>`,
  );

  assert.throws(() => loadRulesets([ruleset]), (error) => {
    assert.ok(error instanceof RulesetError);
    assert.match(error.errors.join("\n"), /too expensive|ignorepattern/i);
    assert.match(error.errors.join("\n"), /BooleanArgumentFlag/);
    assert.match(error.errors.join("\n"), /load-reject\.xml/);
    return true;
  });
});

test("compileIgnorePattern accepts empty and valid patterns, rejects bad ones", () => {
  assert.equal(compileIgnorePattern(""), undefined);

  const exactMax = "a".repeat(maxIgnorePatternLength);
  const atMax = compileIgnorePattern(exactMax);
  assert.ok(atMax instanceof RegExp);

  const regex = compileIgnorePattern("^skip");
  assert.ok(regex instanceof RegExp);
  assert.equal(regex.test("skipMe"), true);
  assert.equal(regex.test("keepMe"), false);
  assert.equal(compileIgnorePattern("^skip"), regex);

  assert.throws(() => compileIgnorePattern("["), (error) => {
    assert.ok(error instanceof IgnorePatternError);
    assert.equal(error.name, "IgnorePatternError");
    assert.match(error.message, /^Invalid ignorepattern:/);
    return true;
  });
  assert.throws(() => compileIgnorePattern("["), IgnorePatternError);

  assert.throws(() => compileIgnorePattern("a".repeat(maxIgnorePatternLength + 1)), (error) => {
    assert.ok(error instanceof IgnorePatternError);
    assert.match(error.message, new RegExp(`maximum length of ${maxIgnorePatternLength}`));
    return true;
  });

  assert.throws(() => compileIgnorePattern("(a+)+$"), (error) => {
    assert.ok(error instanceof IgnorePatternError);
    assert.match(error.message, /too expensive/);
    assert.equal(error.transient, true);
    return true;
  });
  assert.throws(() => compileIgnorePattern("(a|a)*$"), IgnorePatternError);
});

test("native entry exposes an isolated ignorepattern probe mode", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/native-entry.cjs", nativeIgnorePatternProbeArgument, "^safe$"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.equal(Number.isFinite(Number(result.stdout)), true);
  assert.equal(result.stderr, "");
});

test("ignorepattern probes route through the native executable only when marked", () => {
  const previousMarker = process.env.MESSCRIPT_NATIVE_EXECUTABLE;
  try {
    delete process.env.MESSCRIPT_NATIVE_EXECUTABLE;
    assert.deepEqual(ignorePatternProbeChildArguments("^safe$", "probe-script"), [
      "-e",
      "probe-script",
    ]);

    process.env.MESSCRIPT_NATIVE_EXECUTABLE = process.execPath;
    assert.deepEqual(ignorePatternProbeChildArguments("^safe$", "probe-script"), [
      nativeIgnorePatternProbeArgument,
      "^safe$",
    ]);
  } finally {
    if (previousMarker === undefined) {
      delete process.env.MESSCRIPT_NATIVE_EXECUTABLE;
    } else {
      process.env.MESSCRIPT_NATIVE_EXECUTABLE = previousMarker;
    }
  }
});

test("a pattern that fails its safety check with a transient timeout is retried, not permanently blacklisted", () => {
  const pattern = `^retry-after-transient-timeout-${Math.random()}$`;
  let calls = 0;
  const flakyAssertCheap = () => {
    calls++;
    if (calls === 1) {
      throw new IgnorePatternError(
        "ignorepattern is too expensive to evaluate (possible ReDoS).",
        { transient: true },
      );
    }
  };

  assert.throws(() => compileIgnorePattern(pattern, flakyAssertCheap), IgnorePatternError);
  assert.equal(calls, 1);

  // A later lookup must re-attempt compilation instead of returning the
  // stale timeout error from the cache.
  const regex = compileIgnorePattern(pattern, flakyAssertCheap);
  assert.equal(calls, 2, "expected the safety check to run again rather than serve a cached timeout");
  assert.ok(regex instanceof RegExp);
  assert.equal(regex.test(pattern.slice(1, -1)), true);

  // Once compiled successfully, subsequent lookups hit the regex cache and
  // must not re-invoke the safety check at all.
  const cachedAgain = compileIgnorePattern(pattern, flakyAssertCheap);
  assert.equal(calls, 2);
  assert.equal(cachedAgain, regex);
});

test("a pattern that fails its safety check with a genuine (non-transient) error stays blacklisted", () => {
  const pattern = `^permanently-rejected-${Math.random()}$`;
  let calls = 0;
  const alwaysRejects = () => {
    calls++;
    throw new IgnorePatternError("ignorepattern is too expensive to evaluate (possible ReDoS).");
  };

  assert.throws(() => compileIgnorePattern(pattern, alwaysRejects), IgnorePatternError);
  assert.equal(calls, 1);

  // A later lookup must return the cached error without re-invoking the
  // (expensive) safety check again.
  assert.throws(() => compileIgnorePattern(pattern, alwaysRejects), IgnorePatternError);
  assert.equal(calls, 1, "expected the cached permanent error to be reused, not re-evaluated");
});

test("compileIgnorePattern accepts cheap patterns under simulated CPU contention", () => {
  // Oversubscribe the machine's cores with busy-looping child processes so
  // interpreter-boot/spawn wall-clock jitter is provoked, then repeatedly
  // compile trivially cheap, uncached patterns. A correct implementation
  // must measure only probe-evaluation cost, not process-spawn overhead,
  // so none of these should throw regardless of load.
  const cpuCount = Math.max(os.cpus().length, 1);
  const busy = [];
  for (let i = 0; i < cpuCount * 4; i++) {
    busy.push(
      spawn(process.execPath, [
        "-e",
        "const end = Date.now() + 5000; while (Date.now() < end) { Math.sqrt(Math.random()); }",
      ]),
    );
  }

  try {
    const failures = [];
    for (let i = 0; i < 20; i++) {
      const pattern = `^x${i}$`;
      try {
        const regex = compileIgnorePattern(pattern);
        assert.ok(regex instanceof RegExp);
      } catch (error) {
        failures.push({ pattern, message: error instanceof Error ? error.message : String(error) });
      }
    }
    assert.deepEqual(
      failures,
      [],
      `expected no failures under load, got: ${JSON.stringify(failures)}`,
    );
  } finally {
    for (const child of busy) child.kill();
  }
});

test("testIgnorePattern respects missing regex and subject length cap", () => {
  assert.equal(testIgnorePattern(undefined, "anything"), false);
  const regex = compileIgnorePattern("^a+$");
  assert.equal(testIgnorePattern(regex, "aaa"), true);
  assert.equal(testIgnorePattern(regex, "bbb"), false);

  const exact = "a".repeat(maxIgnoreSubjectLength);
  assert.equal(testIgnorePattern(regex, exact), true);

  const over = `${"a".repeat(maxIgnoreSubjectLength)}b`;
  assert.equal(testIgnorePattern(regex, over), true);

  const prefixB = `b${"a".repeat(maxIgnoreSubjectLength)}`;
  assert.equal(testIgnorePattern(regex, prefixB), false);
});

test("validateIgnorePatternProperty only checks ignorepattern keys", () => {
  assert.equal(isIgnorePatternProperty("ignorepattern"), true);
  assert.equal(isIgnorePatternProperty(" IgnorePattern "), true);
  assert.equal(isIgnorePatternProperty("IGNOREPATTERN"), true);
  assert.equal(isIgnorePatternProperty("maximum"), false);
  assert.equal(isIgnorePatternProperty("ignore-pattern"), false);

  validateIgnorePatternProperty("maximum", "[");
  validateIgnorePatternProperty("ignorepattern", "");
  validateIgnorePatternProperty("ignorepattern", "^ok");
  assert.throws(() => validateIgnorePatternProperty("ignorepattern", "["), IgnorePatternError);
});

test("validateSelectionProperties rejects bad ignorepattern on a selection", () => {
  assert.throws(
    () =>
      validateSelectionProperties({
        name: "BooleanArgumentFlag",
        rulesetName: "t",
        properties: { ignorepattern: "[" },
      }),
    IgnorePatternError,
  );
  validateSelectionProperties({
    name: "BooleanArgumentFlag",
    rulesetName: "t",
    properties: { ignorepattern: "^skip" },
  });
  validateSelectionProperties({
    name: "LongVariable",
    rulesetName: "t",
    properties: { maximum: "10" },
  });
  validateSelectionProperties({
    name: "BooleanArgumentFlag",
    rulesetName: "t",
    properties: {},
  });
});

test("runRule surfaces invalid ignorepattern without mutating sibling rule config", () => {
  const source = writeSource(
    "run-rule.ts",
    `export function keepFlag(flag: boolean): void {}
export function skipFlag(flag: boolean): void {}
`,
  );
  const definition = getRuleDefinition("BooleanArgumentFlag");
  assert.ok(definition);
  const file = sourceFileFrom(source);

  assert.throws(
    () =>
      runRule(
        definition,
        {
          name: "BooleanArgumentFlag",
          rulesetName: "t",
          properties: { ignorepattern: "[" },
        },
        file,
      ),
    IgnorePatternError,
  );

  const findings = runRule(
    definition,
    {
      name: "BooleanArgumentFlag",
      rulesetName: "t",
      priority: 5,
      properties: { ignorepattern: "^skip" },
    },
    file,
  );
  assert.equal(findings.some((finding) => finding.message.includes("keepFlag")), true);
  assert.equal(findings.some((finding) => finding.message.includes("skipFlag")), false);
  assert.ok(findings.every((finding) => finding.priority === 5));
});

test("unknown rule name still fails analysis before running rules", () => {
  const source = writeSource("unknown-rule.ts", "export const value = 1;\n");
  assert.throws(
    () =>
      analyze([source], [
        {
          name: "NoSuchRule",
          rulesetName: "t",
          properties: {},
        },
      ]),
    /Unknown rule: NoSuchRule/,
  );
});
