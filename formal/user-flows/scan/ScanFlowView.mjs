export const state = (v) => {
  if (v.stage === "Idle") return "Ready to run";
  if (v.stage === "ParsingArguments") return "Parsing CLI arguments";
  if (v.stage === "DiscoveringFiles") return "Discovering source files";
  if (v.stage === "LoadingRulesets") return "Loading rulesets";
  if (v.stage === "AnalyzingAST") return "Analyzing AST";
  if (v.stage === "ApplyingSuppressions") return "Filtering suppressions";
  if (v.stage === "FormattingReport") return "Formatting report";
  if (v.stage === "Completed") {
    if (v.exitCode === 0) return "Clean exit (code 0)";
    if (v.exitCode === 1) return "Operational error exit (code 1)";
    if (v.exitCode === 2) return "Violations reported (code 2)";
    return "Exit";
  }
  return v.stage;
};

export const step = (action, from, to) => {
  if (action === "YouRunMesscript") return "run messcript CLI";
  if (action === "ArgsParsed") return "options validated";
  if (action === "FilesDiscovered") return "walk directory tree";
  if (action === "RulesetsLoaded") return "merge ruleset definitions";
  if (action === "ASTAnalyzedClean") return "no violations found";
  if (action === "ASTAnalyzedWithFindings") return "violations detected";
  if (action === "ParseErrorEncountered") return "file syntax error";
  if (action === "SuppressionsApplied") return "apply pragma masks";
  if (action === "ReportFormatted") return "render report";
  return null;
};

export const group = (v) => {
  if (v.stage === "Completed") return "Exit";
  if (v.stage === "Idle") return "Setup";
  return "Pipeline";
};

export const colors = {
  Setup: "blue",
  Pipeline: "teal",
  Exit: "purple",
};

export const title = "messcript CLI Analysis Flow";
