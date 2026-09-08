import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { applyRuleFilters, loadRulesets } from "../dist/rulesets.js";

let workspace;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "messcript-rulesets-"));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeRuleset(name, xml) {
  const path = join(workspace, name);
  writeFileSync(path, xml);
  return path;
}

test("CDATA property content is used verbatim, without entity-decoding", () => {
  const ruleset = writeRuleset(
    "cdata-verbatim.xml",
    `<ruleset name="cdata-verbatim">
  <rule ref="StaticAccess">
    <properties>
      <property name="exceptions"><value><![CDATA[a &amp; b]]></value></property>
    </properties>
  </rule>
</ruleset>`,
  );

  const loaded = loadRulesets([ruleset]);

  assert.equal(loaded.selections[0].properties.exceptions, "a &amp; b");
});

test("regular (non-CDATA) text content still has entity-decoding applied", () => {
  const ruleset = writeRuleset(
    "non-cdata-decoded.xml",
    `<ruleset name="non-cdata-decoded">
  <rule ref="StaticAccess">
    <properties>
      <property name="exceptions"><value>a &amp; b</value></property>
    </properties>
  </rule>
</ruleset>`,
  );

  const loaded = loadRulesets([ruleset]);

  assert.equal(loaded.selections[0].properties.exceptions, "a & b");
});

test("applyRuleFilters filters by priority range [minimumPriority, maximumPriority]", () => {
  const loaded = {
    rulesets: ["custom"],
    warnings: [],
    selections: [
      { name: "Rule1", rulesetName: "custom", priority: 1, properties: {} },
      { name: "Rule2", rulesetName: "custom", priority: 2, properties: {} },
      { name: "Rule3", rulesetName: "custom", priority: 3, properties: {} },
      { name: "Rule4", rulesetName: "custom", priority: 4, properties: {} },
      { name: "Rule5", rulesetName: "custom", priority: 5, properties: {} },
    ],
  };

  const range1to2 = applyRuleFilters(loaded, { minimumPriority: 1, maximumPriority: 2 });
  assert.deepEqual(range1to2.selections.map((s) => s.name), ["Rule1", "Rule2"]);

  const range2to4 = applyRuleFilters(loaded, { minimumPriority: 2, maximumPriority: 4 });
  assert.deepEqual(range2to4.selections.map((s) => s.name), ["Rule2", "Rule3", "Rule4"]);
});

test("applyRuleFilters handles single boundary filters", () => {
  const loaded = {
    rulesets: ["custom"],
    warnings: [],
    selections: [
      { name: "Rule1", rulesetName: "custom", priority: 1, properties: {} },
      { name: "Rule2", rulesetName: "custom", priority: 2, properties: {} },
      { name: "Rule3", rulesetName: "custom", priority: 3, properties: {} },
      { name: "Rule4", rulesetName: "custom", priority: 4, properties: {} },
      { name: "Rule5", rulesetName: "custom", priority: 5, properties: {} },
    ],
  };

  const max2 = applyRuleFilters(loaded, { maximumPriority: 2 });
  assert.deepEqual(max2.selections.map((s) => s.name), ["Rule1", "Rule2"]);

  const min3 = applyRuleFilters(loaded, { minimumPriority: 3 });
  assert.deepEqual(min3.selections.map((s) => s.name), ["Rule3", "Rule4", "Rule5"]);
});

