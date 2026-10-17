import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after } from "node:test";
import { runCli } from "../dist/cli.js";

const workspace = mkdtempSync(join(tmpdir(), "messcript-explicitness-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

function captureOutput() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { stream, read: () => output };
}

export function messages(name, source, ruleset = "explicitness") {
  const path = join(workspace, name);
  writeFileSync(path, source);
  const stdout = captureOutput();
  const stderr = captureOutput();
  runCli([path, "json", ruleset], { stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(stderr.read(), "");
  return JSON.parse(stdout.read()).findings.map((finding) => `${finding.line}:${finding.ruleName}: ${finding.message}`);
}
