export const state = (v) => {
  if (v.state === "DraftingXmlRuleset") return "Drafting team-policy.xml";
  if (v.state === "ReferencingBaseSet") return "Referencing base ruleset (typescript)";
  if (v.state === "ConfiguringExclusions") return "Excluding rules (<exclude name='...'/>)";
  if (v.state === "OverridingThresholds") return "Tuning thresholds (<property value='...'/>)";
  if (v.state === "ValidatingXmlAndCycles") return "Validating XML and checking cycles";
  if (v.state === "ActiveCustomPolicy") return "Custom policy active for scan";
  if (v.state === "ConfigurationFailed") return "Configuration error reported";
  return v.state;
};

export const step = (action, from, to) => {
  if (action === "ReferenceBase") return "add <rule ref='typescript'/>";
  if (action === "AddExclusion") return "add <exclude name='...'/>";
  if (action === "OverrideThreshold") return "set custom threshold";
  if (action === "Validate") return "invoke messcript with xml";
  if (action === "ValidationSucceeds") return "xml valid, no cycles";
  if (action === "ValidationFails") return "parse error or circular reference";
  return null;
};

export const group = (v) => {
  if (v.state === "DraftingXmlRuleset" || v.state === "ReferencingBaseSet" || v.state === "ConfiguringExclusions" || v.state === "OverridingThresholds") return "Authoring";
  if (v.state === "ValidatingXmlAndCycles") return "Validation";
  if (v.state === "ActiveCustomPolicy") return "Success";
  return "Failure";
};

export const colors = {
  Authoring: "blue",
  Validation: "yellow",
  Success: "teal",
  Failure: "pink",
};

export const title = "Custom XML Ruleset Configuration User Flow";
