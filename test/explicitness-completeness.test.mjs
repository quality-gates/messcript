import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";
import { runCli } from "../dist/cli.js";

const workspace = mkdtempSync(join(tmpdir(), "messcript-completeness-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

test("member writes preserve complete and incomplete callable alternatives", async (t) => {
  for (const [name, source, expected] of [
    [
      "r14-weak-slot-definite-action.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  box.run = effect;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5], ["function outer()", "ImplicitOutput", 6]],
    ],
    [
      "r14-weak-slot-definite-pure.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  box.run = pure;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5]],
    ],
    [
      "r14-weak-slot-partial-opaque.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  if (flag) box.run = pure;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5], ["function outer()", "UnknownEffect", 6]],
    ],
    [
      "r14-weak-slot-exhaustive-pure.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  if (flag) box.run = pure; else box.run = () => 8;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5]],
    ],
    [
      "r14-weak-slot-mixed-opaque-action.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  if (flag) box.run = effect;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5], ["function outer()", "ImplicitOutput", 6], ["function outer()", "UnknownEffect", 6]],
    ],
    [
      "r14-weak-slot-exhaustive-action.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  if (flag) box.run = effect; else box.run = pure;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5], ["function outer()", "ImplicitOutput", 6]],
    ],
    [
      "r14-weak-slot-wildcard-opaque.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  box[key] = pure;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5], ["function outer()", "UnknownEffect", 6]],
    ],
    [
      "r14-weak-slot-wildcard-fixed.ts",
      `const shared: number[] = [0];
function effect() { shared[0] = 1; return 7; }
function pure() { return 7; }
function outer(box: Record<string, () => number>, flag: boolean, key: string) {
  box.run = pure;
  return box.run();
}
`,
      [["function effect()", "ImplicitOutput", 2], ["function outer()", "ImplicitOutput", 5]],
    ],
  ]) {
    await t.test(name, () => {
      const path = join(workspace, name);
      writeFileSync(path, source);
      let stdout = "";
      let stderr = "";
      const status = runCli([path, "json", "explicitness", "--strict"], {
        stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk.toString(); done(); } }),
        stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk.toString(); done(); } }),
      });
      assert.equal(status, 2);
      assert.equal(stderr, "");
      const report = JSON.parse(stdout);
      assert.deepEqual(report.errors, []);
      const actual = report.findings.map((finding) => {
        assert.equal(resolve(finding.path), path);
        return [finding.context, finding.ruleName, finding.line];
      });
      assert.deepEqual(actual.sort(), expected.sort());
    });
  }
});
