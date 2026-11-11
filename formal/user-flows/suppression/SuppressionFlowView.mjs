export const state = (v) => {
  if (v.state === "ViolationFound") return "Violation detected in source";
  if (v.state === "NextLineDirectiveAdded") return "Single line suppressed";
  if (v.state === "RegionDisabled") return "Region disable active";
  if (v.state === "RegionEnabled") return "Region enable restored";
  if (v.state === "ScanClean") return "Clean report (violation hidden)";
  if (v.state === "ScanStrictFlagged") return "Strict report (flagged as [suppressed])";
  return v.state;
};

export const step = (action, from, to) => {
  if (action === "AddNextLine") return "add // messcript-disable-next-line";
  if (action === "AddRegionDisable") return "add /* messcript-disable */";
  if (action === "AddRegionEnable") return "add /* messcript-enable */";
  if (action === "RunNormalScan") return "run default scan";
  if (action === "RunStrictScan") return "run scan with --strict";
  if (action === "ResumeScanAfterRegion") return "scan lines after region";
  return null;
};

export const group = (v) => {
  if (v.state === "ViolationFound") return "Detection";
  if (v.state === "NextLineDirectiveAdded" || v.state === "RegionDisabled" || v.state === "RegionEnabled") return "Authoring";
  return "Output";
};

export const colors = {
  Detection: "orange",
  Authoring: "teal",
  Output: "purple",
};

export const title = "In-Source Comment Suppression User Flow";
