import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { formatAnsi, formatGithub, formatGitlab, formatHtml } from "../dist/reporters/human.js";
import { formatCheckstyle, formatJson, formatSarif, formatStructured, formatXml } from "../dist/reporters/structured.js";
import { formatText } from "../dist/reporters/text.js";

const root = process.cwd();
const tool = { name: "messcript", version: "9.8.7" };

function finding(path, line, column, ruleName, message, context, priority = 3, suppressed = false) {
  return { path, line, column, ruleName, message, context, priority, suppressed };
}

function error(path, line, column, message) {
  return { path, line, column, message };
}

test("text reports sort findings and errors and preserve empty output", () => {
  const findings = [
    finding("z.ts", 2, 3, "ZRule", "z message", "z context", 2),
    finding("a.ts", 2, 3, "ARule", "a message", "a context", 1, true),
    finding("same.ts", 2, 3, "ZRule", "z message", "z context", 2),
    finding("same.ts", 2, 3, "ARule", "a message", "a context", 1),
  ];
  const errors = [error("a.ts", 2, 3, "z error"), error("a.ts", 2, 3, "a error")];

  assert.equal(formatText([]), "");
  assert.equal(
    formatText(findings, errors),
      "a.ts:2:3: ARule [priority 1] [suppressed] a message (context: a context)\n" +
      "a.ts:2:3: ProcessingError a error\n" +
      "a.ts:2:3: ProcessingError z error\n" +
      "same.ts:2:3: ARule [priority 1] a message (context: a context)\n" +
      "same.ts:2:3: ZRule [priority 2] z message (context: z context)\n" +
      "z.ts:2:3: ZRule [priority 2] z message (context: z context)\n",
  );
});

test("HTML reports cover escaping, ordering, suppression, errors, and empty documents", () => {
  const ordered = formatHtml([
    finding("ordered.ts", 1, 1, "RuleB", "same", "context"),
    finding("ordered.ts", 1, 1, "RuleA", "z", "context"),
    finding("ordered.ts", 1, 1, "RuleA", "a", "context"),
  ], []);
  assert.ok(ordered.indexOf(">a<") < ordered.indexOf(">z<"));
  assert.ok(ordered.indexOf(">z<") < ordered.indexOf(">same<"));

  const html = formatHtml([
    finding(join(root, "z.ts"), 2, 3, "Rule<&", "message<&>\"'", "context<&>\"'", 4, true),
    finding(join(root, "a.ts"), 1, 1, "RuleA", "message", "context"),
  ], [error(join(root, "broken<&.ts"), 4, 5, "error<&>\"'")]);
  assert.match(html, /<h2>a\.ts<\/h2>[\s\S]*<h2>z\.ts<\/h2>/);
  assert.match(html, /class="suppressed"/);
  assert.match(html, /Rule&lt;&amp;/);
  assert.match(html, /message&lt;&amp;&gt;&quot;&#039;/);
  assert.match(html, /broken&lt;&amp;\.ts/);
  assert.match(html, /error&lt;&amp;&gt;&quot;&#039;/);
  assert.match(html, /<table><tr><th>Line<\/th><th>Column<\/th>/);
  assert.match(html, /<td>context<\/td><td><\/td><\/tr>/);
  assert.match(html, /<h2>Processing errors<\/h2>\n<table><tr><th>Line<\/th>/);
  const sameErrors = formatHtml([], [error("errors.ts", 1, 1, "z"), error("errors.ts", 1, 1, "a")]);
  assert.ok(sameErrors.indexOf(">a<") < sameErrors.indexOf(">z<"));
  const sameFindings = formatHtml([
    finding("same.ts", 1, 1, "Rule", "same", "second"),
    finding("same.ts", 1, 1, "Rule", "same", "first"),
  ], []);
  assert.ok(sameFindings.indexOf(">second<") < sameFindings.indexOf(">first<"));

  const nestedAndExternal = formatHtml([
    finding(join(root, "nested", "a.ts"), 1, 1, "Nested", "message", "context"),
    finding(join(root, "..", "external.ts"), 1, 1, "External", "message", "context"),
  ], []);
  assert.match(nestedAndExternal, /<h2>nested\/a\.ts<\/h2>/);
  assert.match(nestedAndExternal, new RegExp(`<h2>${join(root, "..", "external.ts")}<\\/h2>`));

  assert.equal(
    formatHtml([], []),
    "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>messcript report</title>\n" +
      "<style>body{font-family:system-ui,sans-serif}table{border-collapse:collapse;margin:0 0 1.5rem}th,td{border:1px solid #ccc;padding:.3rem .5rem;text-align:left}th{background:#eee}.suppressed{opacity:.65}</style>\n" +
      "</head><body>\n<h1>messcript report</h1>\n</body></html>\n",
  );
});

test("ANSI, GitHub, and GitLab reports preserve colors, escapes, locations, and severities", () => {
  const ansi = formatAnsi([
    finding("a.ts", 1, 2, "Rule", "message", "ctx\x1b[31 m", 1, true),
  ], [error("z.ts", 3, 4, "bad")]);
  assert.equal(
    ansi,
    "a.ts:1:2: \x1b[33mRule [priority 1] [suppressed]\x1b[0m \x1b[31mmessage\x1b[0m (context: ctx)\n" +
      "z.ts:3:4: \x1b[31mProcessingError bad\x1b[0m\n",
  );
  assert.equal(formatAnsi([], []), "");

  const specialPath = join(root, "special%,\n:.ts");
  const github = formatGithub([
    finding(specialPath, 2, 3, "Rule:Name", "message%,\r\n:", "context%,\r\n:", 2, true),
  ], [error(specialPath, 4, 5, "error%,\r\n:")]);
  assert.equal(
    github,
    "::warning file=special%25%2C%0A%3A.ts,line=2,col=3,title=Rule%3AName [priority 2]::message%25%2C%0D%0A%3A (context%3A context%25%2C%0D%0A%3A) [suppressed]\n" +
      "::error file=special%25%2C%0A%3A.ts,line=4,col=5,title=ProcessingError::error%25%2C%0D%0A%3A\n",
  );

  const gitlab = JSON.parse(formatGitlab([
    finding("one.ts", 1, 1, "One", "one", "one", 1),
    finding("two.ts", 1, 1, "Two", "two", "two", 2),
    finding("three.ts", 1, 1, "Three", "three", "three", 3),
    finding("four.ts", 1, 1, "Four", "four", "four", 4),
    finding("five.ts", 1, 1, "Five", "five", "five", 5),
    finding("six.ts", 1, 1, "Six", "six", "six", 6),
  ], []));
  assert.deepEqual(Object.fromEntries(gitlab.map((entry) => [entry.check_name, entry.severity])), {
    One: "blocker",
    Two: "critical",
    Three: "major",
    Four: "minor",
    Five: "info",
    Six: "info",
  });
  const one = gitlab.find((entry) => entry.check_name === "One");
  assert.equal(one.location.path, "one.ts");
  assert.equal(one.type, "issue");
  assert.equal(one.description, "one (context: one)");
  assert.equal(one.priority, 1);
  assert.equal(one.suppressed, false);
  assert.match(Buffer.from(one.fingerprint, "hex").toString("utf8"), /one\.ts:1:1:One:one/);
  assert.equal(JSON.parse(formatGitlab([finding("suppressed.ts", 1, 1, "Suppressed", "message", "context", 3, true)], []))[0].suppressed, true);
  const gitlabError = JSON.parse(formatGitlab([], [error("bad.ts", 2, 3, "bad")]))[0];
  assert.equal(gitlabError.type, "issue");
  assert.equal(gitlabError.check_name, "ProcessingError");
  assert.equal(gitlabError.description, "bad");
  assert.equal(gitlabError.severity, "blocker");
  assert.equal(gitlabError.suppressed, false);
  assert.match(Buffer.from(gitlabError.fingerprint, "hex").toString("utf8"), /bad\.ts:2:3:ProcessingError:bad/);
  assert.deepEqual(JSON.parse(formatGitlab([], [])), []);
});

test("structured reports preserve metadata, sorting, escaping, suppression, and notifications", () => {
  const findings = [
    finding("z.ts", 2, 2, "ZRule", "z", "z context", 4),
    finding("a.ts", 1, 1, "ARule", "a<&>\"'", "ctx", 2, true),
    finding("same.ts", 1, 1, "Rule", "z", "z", 4),
    finding("same.ts", 1, 1, "Rule", "a", "a", 1),
    finding("same.ts", 1, 1, "ARule", "x", "x", 3),
    finding("priority.ts", 1, 1, "Rule", "same", "same", 4),
    finding("priority.ts", 1, 1, "Rule", "same", "same", 1),
  ];
  const errors = [error("a.ts", 3, 4, "z error"), error("a.ts", 3, 4, "a error"), error("a.ts", 4, 5, "bad<&\"'")];

  const json = JSON.parse(formatJson(findings, errors, tool));
  assert.deepEqual(json.tool, tool);
  assert.deepEqual(json.findings.map((item) => `${item.path}:${item.ruleName}:${item.message}`), [
    "a.ts:ARule:a<&>\"'",
    "priority.ts:Rule:same",
    "priority.ts:Rule:same",
    "same.ts:ARule:x",
    "same.ts:Rule:a",
    "same.ts:Rule:z",
    "z.ts:ZRule:z",
  ]);
  assert.deepEqual(json.findings.filter((item) => item.path === "priority.ts").map((item) => item.priority), [1, 4]);
  assert.equal(json.findings[0].suppressed, true);
  assert.deepEqual(json.errors.map((item) => item.message), ["a error", "z error", "bad<&\"'"]);
  assert.match(formatJson([], [], tool), /"findings": \[\]/);

  const xml = formatXml(findings, errors, tool);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<tool name="messcript" version="9\.8\.7" \/>/);
  assert.match(xml, /message="a&lt;&amp;&gt;&quot;&apos;" context="ctx"/);
  assert.match(xml, /<error[^>]+message="bad&lt;&amp;&quot;&apos;"/);

  const checkstyle = formatCheckstyle(findings, errors, tool);
  assert.match(checkstyle, /<checkstyle tool="messcript" version="9\.8\.7">/);
  assert.match(checkstyle, /source="messcript\.ARule"/);
  assert.match(checkstyle, /severity="error" message="bad&lt;&amp;&quot;&apos;" source="messcript\.ProcessingError"/);
  assert.match(checkstyle, /<file name="a\.ts">[\s\S]*<\/file>[\s\S]*<file name="z\.ts">/);

  const sarif = JSON.parse(formatSarif([
    finding("z.ts", 2, 2, "ZRule", "z", "z context"),
    finding("a.ts", 1, 1, "ARule", "a", "a context", 2, true),
    finding("a.ts", 1, 2, "ARule", "a2", "a2 context"),
  ], errors, tool));
  const run = sarif.runs[0];
  assert.deepEqual(run.tool.driver.rules.map((rule) => rule.id), ["ARule", "ZRule"]);
  assert.equal(sarif.$schema, "https://json.schemastore.org/sarif-2.1.0.json");
  assert.equal(run.tool.driver.rules[0].shortDescription.text, "ARule");
  assert.equal(run.results[0].ruleId, "ARule");
  assert.equal(run.results[0].level, "warning");
  assert.equal(run.results[0].message.text, "a");
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, "a.ts");
  assert.deepEqual(run.results[0].suppressions, [{ kind: "inSource" }]);
  assert.equal(run.invocations[0].executionSuccessful, false);
  assert.equal(run.invocations[0].toolExecutionNotifications[0].level, "error");
  assert.equal(run.invocations[0].toolExecutionNotifications[0].locations[0].physicalLocation.region.startColumn, 4);
  const cleanSarif = JSON.parse(formatSarif([], [], tool));
  assert.equal(cleanSarif.runs[0].invocations[0].executionSuccessful, true);
  assert.equal("toolExecutionNotifications" in cleanSarif.runs[0].invocations[0], false);

  assert.equal(JSON.parse(formatStructured("JSON", [], [], tool)).tool.name, "messcript");
  assert.throws(() => formatStructured("unknown", [], [], tool), /Unknown format: unknown/);
});
