import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadRulesets } from "../dist/rulesets.js";

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
