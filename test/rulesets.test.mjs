import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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


function rulesetError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected loadRulesets to throw");
}

test("entity references decode in attribute values, including quotes", () => {
  const ruleset = writeRuleset(
    "entity-attributes.xml",
    `<ruleset name="a &lt; b &gt; &quot;q&quot; &apos;d&apos;">
  <rule ref="StaticAccess" />
</ruleset>`,
  );

  const loaded = loadRulesets([ruleset]);

  assert.equal(loaded.selections[0].rulesetName, 'a < b > "q" \'d\'');
});

test("entity references decode in element text", () => {
  const ruleset = writeRuleset(
    "entity-text.xml",
    `<ruleset name="entity-text">
  <rule ref="StaticAccess">
    <properties>
      <property name="exceptions"><value>a &lt; b &gt; &quot;c&quot; &apos;d&apos;</value></property>
    </properties>
  </rule>
</ruleset>`,
  );

  const loaded = loadRulesets([ruleset]);

  assert.equal(loaded.selections[0].properties.exceptions, 'a < b > "c" \'d\'');
});

test("attributes may contain > inside quoted values", () => {
  const doubleQuoted = writeRuleset(
    "quoted-double.xml",
    `<ruleset name="a>b"><rule ref="StaticAccess" /></ruleset>`,
  );
  const singleQuoted = writeRuleset(
    "quoted-single.xml",
    `<ruleset name='c>"d'><rule ref="StaticAccess" /></ruleset>`,
  );

  assert.equal(loadRulesets([doubleQuoted]).selections[0].rulesetName, "a>b");
  assert.equal(loadRulesets([singleQuoted]).selections[0].rulesetName, 'c>"d');
});

test("tag boundaries tolerate whitespace inside the tag", () => {
  const padded = writeRuleset(
    "padded-tags.xml",
    `<ruleset name="padded-tags" >
  <rule ref="StaticAccess" />
< /ruleset >
`,
  );

  const loaded = loadRulesets([padded]);

  assert.equal(loaded.selections[0].rulesetName, "padded-tags");
});

test("self-closing rule elements do not leave an open element", () => {
  const selfClosing = writeRuleset(
    "self-closing-rule.xml",
    `<ruleset name="self-closing-rule">
  <rule ref="StaticAccess" />
  <rule ref="ShortVariable" />
</ruleset>`,
  );

  const loaded = loadRulesets([selfClosing]);

  assert.deepEqual(
    loaded.selections.map((s) => s.name).sort(),
    ["ShortVariable", "StaticAccess"],
  );
});

test("xml declaration, doctype, and comments are skipped", () => {
  const prolog = writeRuleset(
    "prolog.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ruleset>
<!-- a comment with <fake> markup -->
<ruleset name="prolog">
  <rule ref="StaticAccess" />
</ruleset>`,
  );

  const loaded = loadRulesets([prolog]);

  assert.equal(loaded.selections[0].rulesetName, "prolog");
});

test("unclosed comments, cdata, declarations, and tags are errors", () => {
  const unclosedComment = writeRuleset("unclosed-comment.xml", `<!-- oops`);
  const unclosedCdata = writeRuleset(
    "unclosed-cdata.xml",
    `<ruleset name="x"><rule ref="StaticAccess"><value><![CDATA[nope</value></rule></ruleset>`,
  );
  const unclosedDeclaration = writeRuleset("unclosed-declaration.xml", `<?xml version="1.0"`);
  const unclosedTag = writeRuleset("unclosed-tag.xml", `<ruleset name="x"`);

  for (const path of [unclosedComment, unclosedCdata, unclosedDeclaration, unclosedTag]) {
    const error = rulesetError(() => loadRulesets([path]));
    assert.match(error.message, /Could not read custom ruleset/);
  }

  assert.match(rulesetError(() => loadRulesets([unclosedComment])).message, /XML comment is not closed/);
  assert.match(rulesetError(() => loadRulesets([unclosedCdata])).message, /XML CDATA section is not closed/);
  assert.match(rulesetError(() => loadRulesets([unclosedDeclaration])).message, /XML declaration is not closed/);
  assert.match(rulesetError(() => loadRulesets([unclosedTag])).message, /XML tag is not closed/);
});

test("malformed documents produce distinct structural errors", () => {
  const textOutsideRoot = writeRuleset("text-outside-root.xml", `stray text<ruleset name="x" />`);
  const twoRoots = writeRuleset(
    "two-roots.xml",
    `<ruleset name="one" /><ruleset name="two" />`,
  );
  const emptyDocument = writeRuleset("empty-document.xml", `<!-- nothing but a comment -->`);
  const unclosedElement = writeRuleset(
    "unclosed-element.xml",
    `<ruleset name="x"><rule ref="StaticAccess" />`,
  );
  const mismatchedClose = writeRuleset(
    "mismatched-close.xml",
    `<ruleset name="x"><rule ref="StaticAccess"></rul></ruleset>`,
  );

  assert.match(rulesetError(() => loadRulesets([textOutsideRoot])).message, /XML has text outside its root element/);
  assert.match(rulesetError(() => loadRulesets([twoRoots])).message, /XML has more than one root element/);
  assert.match(rulesetError(() => loadRulesets([emptyDocument])).message, /XML has no root element/);
  assert.match(rulesetError(() => loadRulesets([unclosedElement])).message, /XML element is not closed: ruleset/);
  assert.match(rulesetError(() => loadRulesets([mismatchedClose])).message, /XML closing tag does not match: rul/);
});

test("multiple ruleset failures are joined with newlines in the error", () => {
  const error = rulesetError(() => loadRulesets(["no-such-a", "no-such-b"]));

  assert.deepEqual(error.errors, ["Unknown ruleset 'no-such-a'.", "Unknown ruleset 'no-such-b'."]);
  assert.equal(error.message, "Unknown ruleset 'no-such-a'.\nUnknown ruleset 'no-such-b'.");
});

test("uppercase attribute names are read case-insensitively", () => {
  const upper = writeRuleset(
    "upper-attributes.xml",
    `<RULESET NAME="upper-attributes"><RULE REF="StaticAccess" /></RULESET>`,
  );

  const loaded = loadRulesets([upper]);

  assert.equal(loaded.selections[0].rulesetName, "upper-attributes");
  assert.equal(loaded.selections[0].name, "StaticAccess");
});

test("priority inherits from the enclosing ruleset and validates its range", () => {
  const inherited = writeRuleset(
    "priority-inherited.xml",
    `<ruleset name="priority-inherited" priority="2">
  <rule ref="StaticAccess" />
  <rule ref="ShortVariable" priority="5" />
</ruleset>`,
  );
  const invalid = writeRuleset(
    "priority-invalid.xml",
    `<ruleset name="priority-invalid"><rule ref="StaticAccess" priority="6" /></ruleset>`,
  );
  const notInteger = writeRuleset(
    "priority-not-integer.xml",
    `<ruleset name="priority-not-integer"><rule ref="StaticAccess" priority="2.5" /></ruleset>`,
  );
  const boundary = writeRuleset(
    "priority-boundary.xml",
    `<ruleset name="priority-boundary">
  <rule ref="StaticAccess" priority="1" />
  <rule ref="ShortVariable" priority="5" />
</ruleset>`,
  );

  const loaded = loadRulesets([inherited]);
  assert.equal(loaded.selections.find((s) => s.name === "StaticAccess").priority, 2);
  assert.equal(loaded.selections.find((s) => s.name === "ShortVariable").priority, 5);

  const bounded = loadRulesets([boundary]);
  assert.deepEqual(bounded.selections.map((s) => s.priority).sort(), [1, 5]);

  const outOfRange = rulesetError(() => loadRulesets([invalid]));
  assert.deepEqual(outOfRange.errors, [`Priority in '${invalid}' must be an integer between 1 and 5.`]);
  const fractional = rulesetError(() => loadRulesets([notInteger]));
  assert.deepEqual(fractional.errors, [`Priority in '${notInteger}' must be an integer between 1 and 5.`]);
});

test("property value elements trim their text", () => {
  const ruleset = writeRuleset(
    "property-trim.xml",
    `<ruleset name="property-trim">
  <rule ref="LongVariable">
    <properties>
      <property name="maximum"><value>  12  </value></property>
      <property name="only-value" />
    </properties>
  </rule>
</ruleset>`,
  );

  const loaded = loadRulesets([ruleset]);
  const longVariable = loaded.selections.find((s) => s.name === "LongVariable");

  assert.equal(longVariable.properties.maximum, "12");
  assert.equal("only-value" in longVariable.properties, false);
});

test("built-in component references accept several spellings", () => {
  const byRef = writeRuleset(
    "component-ref.xml",
    `<ruleset name="component-ref"><rule ref="TypeScript" /></ruleset>`,
  );
  const byDirectory = writeRuleset(
    "component-directory.xml",
    `<ruleset name="component-directory"><rule ref="rulesets/typescript.xml" /></ruleset>`,
  );
  const byFileName = writeRuleset(
    "component-file.xml",
    `<ruleset name="component-file"><rule ref="typescript.xml" /></ruleset>`,
  );
  const relative = writeRuleset(
    "component-relative.xml",
    `<ruleset name="component-relative"><rule ref="./typescript" /></ruleset>`,
  );

  for (const path of [byRef, byDirectory, byFileName, relative]) {
    const loaded = loadRulesets([path]);
    assert.equal(loaded.selections.some((s) => s.name === "CyclomaticComplexity"), true, path);
  }
});

test("component and rule references resolve the single named rule", () => {
  const combined = writeRuleset(
    "component-rule-ref.xml",
    `<ruleset name="component-rule-ref"><rule ref="TypeScript/ShortVariable" /></ruleset>`,
  );
  const unknownRule = writeRuleset(
    "component-rule-unknown.xml",
    `<ruleset name="component-rule-unknown"><rule ref="TypeScript/Bogus" /></ruleset>`,
  );

  const loaded = loadRulesets([combined]);
  assert.deepEqual(loaded.selections.map((s) => s.name), ["ShortVariable"]);
  assert.deepEqual(loaded.warnings, []);

  const warned = loadRulesets([unknownRule]);
  assert.deepEqual(warned.selections, []);
  assert.deepEqual(warned.warnings, [`Unknown referenced rule 'Bogus' in '${unknownRule}'.`]);
});

test("unknown referenced rulesets and malformed references are errors or warnings", () => {
  const unknownFile = writeRuleset(
    "unknown-file-ref.xml",
    `<ruleset name="unknown-file-ref"><rule ref="./no-such-ruleset.xml" /></ruleset>`,
  );
  const unknownNamed = writeRuleset(
    "unknown-named-ref.xml",
    `<ruleset name="unknown-named-ref"><ruleset name="no-such-component" /></ruleset>`,
  );
  const ununderstood = writeRuleset(
    "ununderstood-ref.xml",
    `<ruleset name="ununderstood-ref"><ruleset /></ruleset>`,
  );
  const unknownDirectRule = writeRuleset(
    "unknown-direct-rule.xml",
    `<ruleset name="unknown-direct-rule"><rule name="NoSuchRule" /></ruleset>`,
  );

  const fileError = rulesetError(() => loadRulesets([unknownFile]));
  assert.deepEqual(fileError.errors, [`Unknown referenced ruleset './no-such-ruleset.xml' in '${unknownFile}'.`]);

  const namedWarning = loadRulesets([unknownNamed]);
  assert.deepEqual(namedWarning.warnings, [`Unknown referenced ruleset 'no-such-component' in '${unknownNamed}'.`]);

  const shapeWarning = loadRulesets([ununderstood]);
  assert.deepEqual(shapeWarning.warnings, [`Could not understand ruleset reference in '${ununderstood}'.`]);

  const ruleError = rulesetError(() => loadRulesets([unknownDirectRule]));
  assert.deepEqual(ruleError.errors, [`Unknown rule 'NoSuchRule' in '${unknownDirectRule}'.`]);
});

test("ignorepattern property failures name the rule and ruleset", () => {
  const ruleset = writeRuleset(
    "bad-ignorepattern.xml",
    `<ruleset name="bad-ignorepattern">
  <rule ref="StaticAccess">
    <properties><property name="ignorepattern" value="(" /></properties>
  </rule>
</ruleset>`,
  );

  const error = rulesetError(() => loadRulesets([ruleset]));

  assert.match(error.errors[0], /Invalid ignorepattern:/);
  assert.match(error.errors[0], /\(rule 'StaticAccess' in/);
});

test("ruleset files without a name attribute fall back to the file name", () => {
  const anonymous = writeRuleset(
    "anonymous.xml",
    `<ruleset><rule ref="StaticAccess" /></ruleset>`,
  );

  const loaded = loadRulesets([anonymous]);

  assert.equal(loaded.selections[0].rulesetName, "anonymous");
});

test("a non-ruleset root element is an error", () => {
  const wrongRoot = writeRuleset("wrong-root.xml", `<not-a-ruleset><rule ref="StaticAccess" /></not-a-ruleset>`);

  const error = rulesetError(() => loadRulesets([wrongRoot]));

  assert.deepEqual(error.errors, [`Custom ruleset '${wrongRoot}' must have a ruleset root element.`]);
});

test("circular custom ruleset references are errors with both paths", () => {
  const first = writeRuleset(
    "cycle-a.xml",
    `<ruleset name="cycle-a"><rule ref="./cycle-b.xml" /></ruleset>`,
  );
  const second = writeRuleset(
    "cycle-b.xml",
    `<ruleset name="cycle-b"><rule ref="./cycle-a.xml" /></ruleset>`,
  );

  const error = rulesetError(() => loadRulesets([first]));

  assert.deepEqual(error.errors, [`Circular ruleset reference '${first}' in '${second}'.`]);
});

test("an unreadable custom ruleset path is an operational error", () => {
  const directory = join(workspace, "ruleset-directory");
  mkdirSync(directory);

  const error = rulesetError(() => loadRulesets([directory]));

  assert.match(error.errors[0], /^Could not read custom ruleset '.*ruleset-directory': /);
});

test("a missing custom ruleset path is an unknown ruleset error", () => {
  const error = rulesetError(() => loadRulesets([join(workspace, "no-such-ruleset.xml")]));

  assert.deepEqual(error.errors, [`Unknown ruleset '${join(workspace, "no-such-ruleset.xml")}'.`]);
});

test("container-level excludes remove named rules from expansions", () => {
  const excluded = writeRuleset(
    "container-exclude.xml",
    `<ruleset name="container-exclude">
  <exclude name="LongVariable" />
  <rule ref="TypeScript" />
</ruleset>`,
  );
  const selfExcluded = writeRuleset(
    "rule-self-exclude.xml",
    `<ruleset name="rule-self-exclude">
  <rule ref="StaticAccess"><exclude name="staticaccess" /></rule>
</ruleset>`,
  );

  const container = loadRulesets([excluded]);
  assert.equal(container.selections.some((s) => s.name === "LongVariable"), false);
  assert.equal(container.selections.some((s) => s.name === "CyclomaticComplexity"), true);

  const self = loadRulesets([selfExcluded]);
  assert.deepEqual(self.selections, []);
});

test("unknown child elements are ignored without warnings", () => {
  const documented = writeRuleset(
    "with-description.xml",
    `<ruleset name="with-description">
  <description>House policy.</description>
  <rule ref="StaticAccess" />
</ruleset>`,
  );

  const loaded = loadRulesets([documented]);

  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.selections.length, 1);
});

test("nested ruleset containers expand both built-in refs and inline rules", () => {
  const nested = writeRuleset(
    "nested-container.xml",
    `<ruleset name="nested-container">
  <ruleset ref="StaticAccess" />
  <ruleset name="typescript" />
  <ruleset name="inline">
    <rule ref="ShortVariable" priority="4" />
  </ruleset>
</ruleset>`,
  );

  const loaded = loadRulesets([nested]);

  const names = loaded.selections.map((s) => s.name);
  assert.equal(names.includes("StaticAccess"), true);
  assert.equal(names.includes("CyclomaticComplexity"), true);
  assert.equal(loaded.selections.find((s) => s.name === "ShortVariable").priority, 4);
});

test("long variable maximum comes from the language policy for javascript and typescript only", () => {
  const language = writeRuleset(
    "language-policy.xml",
    `<ruleset name="language-policy"><rule ref="TypeScript" /></ruleset>`,
  );
  const naming = writeRuleset(
    "naming-policy.xml",
    `<ruleset name="naming-policy"><rule ref="Naming" /></ruleset>`,
  );

  const loaded = loadRulesets([language]);
  assert.equal(loaded.selections.find((s) => s.name === "LongVariable").properties.maximum, "35");

  const namingLoaded = loadRulesets([naming]);
  const namingLongVariable = namingLoaded.selections.find((s) => s.name === "LongVariable");
  assert.equal(namingLongVariable !== undefined, true);
  assert.equal("maximum" in namingLongVariable.properties, false);
});

test("repeat selections merge properties and keep the newest ruleset name", () => {
  const first = writeRuleset(
    "merge-first.xml",
    `<ruleset name="merge-first" priority="2">
  <rule ref="TypeScript">
    <properties><property name="ignorepattern" value="^fixtures" /></properties>
  </rule>
</ruleset>`,
  );
  const second = writeRuleset(
    "merge-second.xml",
    `<ruleset name="merge-second">
  <rule ref="TypeScript" priority="4" />
</ruleset>`,
  );
  const third = writeRuleset(
    "merge-third.xml",
    `<ruleset name="merge-third">
  <rule ref="TypeScript" />
</ruleset>`,
  );

  const loaded = loadRulesets([first, second, third]);
  const merged = loaded.selections.filter((s) => s.name === "CyclomaticComplexity");

  assert.equal(merged.length, 1);
  assert.equal(merged[0].rulesetName, "merge-third");
  assert.equal(merged[0].priority, 4);
  assert.equal(merged[0].properties.ignorepattern, "^fixtures");
});

test("repeat selections without a priority keep the earlier priority", () => {
  const first = writeRuleset(
    "merge-priority-first.xml",
    `<ruleset name="merge-priority-first" priority="2">
  <rule ref="StaticAccess" />
</ruleset>`,
  );
  const second = writeRuleset(
    "merge-priority-second.xml",
    `<ruleset name="merge-priority-second">
  <rule ref="StaticAccess" />
</ruleset>`,
  );

  const loaded = loadRulesets([first, second]);

  assert.equal(loaded.selections[0].priority, 2);
  assert.equal(loaded.selections[0].rulesetName, "merge-priority-second");
});

test("ruleset names are trimmed before lookup", () => {
  const loaded = loadRulesets(["  TypeScript  "]);

  assert.equal(loaded.selections.some((s) => s.name === "CyclomaticComplexity"), true);
  assert.deepEqual(loaded.warnings, []);
});

test("applyRuleFilters trims and case-folds only, enable, and disable names", () => {
  const loaded = loadRulesets(["TypeScript"]);

  const requested = applyRuleFilters(loaded, { only: ["  LongVariable  "] });
  assert.deepEqual(requested.selections.map((s) => s.name), ["LongVariable"]);

  const enabled = applyRuleFilters(loaded, { only: [], enable: [" LONGVARIABLE "] });
  assert.deepEqual(enabled.selections.map((s) => s.name), ["LongVariable"]);

  const disabled = applyRuleFilters(loaded, { disable: [" LongVariable "] });
  assert.equal(disabled.selections.some((s) => s.name === "LongVariable"), false);
  assert.equal(disabled.selections.some((s) => s.name === "CyclomaticComplexity"), true);
});

test("applyRuleFilters rejects requested and disabled rules missing from the loaded rulesets", () => {
  const loaded = loadRulesets(["TypeScript"]);

  assert.throws(
    () => applyRuleFilters(loaded, { only: ["LongVariable", "NoSuchRule"] }),
    (error) => error.message === "Requested rule 'nosuchrule' is not present in the loaded rulesets.",
  );
  assert.throws(
    () => applyRuleFilters(loaded, { disable: ["NoSuchRule"] }),
    (error) => error.message === "Disabled rule 'nosuchrule' is not present in the loaded rulesets.",
  );
});
