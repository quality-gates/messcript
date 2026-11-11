---- MODULE SuppressionFlow ----
EXTENDS Naturals, Sequences

VARIABLES state, directiveKind, strictFlag

vars == <<state, directiveKind, strictFlag>>

States == {
  "ViolationFound",
  "NextLineDirectiveAdded",
  "RegionDisabled",
  "RegionEnabled",
  "ScanClean",
  "ScanStrictFlagged"
}

Init ==
  /\ state = "ViolationFound"
  /\ directiveKind = "none"
  /\ strictFlag \in BOOLEAN

AddNextLine ==
  /\ state = "ViolationFound"
  /\ directiveKind' = "disable_next_line"
  /\ state' = "NextLineDirectiveAdded"
  /\ UNCHANGED strictFlag

AddRegionDisable ==
  /\ state = "ViolationFound"
  /\ directiveKind' = "disable"
  /\ state' = "RegionDisabled"
  /\ UNCHANGED strictFlag

AddRegionEnable ==
  /\ state = "RegionDisabled"
  /\ directiveKind' = "enable"
  /\ state' = "RegionEnabled"
  /\ UNCHANGED strictFlag

RunNormalScan ==
  /\ state \in {"NextLineDirectiveAdded", "RegionDisabled"}
  /\ ~strictFlag
  /\ state' = "ScanClean"
  /\ UNCHANGED <<directiveKind, strictFlag>>

RunStrictScan ==
  /\ state \in {"NextLineDirectiveAdded", "RegionDisabled"}
  /\ strictFlag
  /\ state' = "ScanStrictFlagged"
  /\ UNCHANGED <<directiveKind, strictFlag>>

ResumeScanAfterRegion ==
  /\ state = "RegionEnabled"
  /\ state' = "ViolationFound"
  /\ directiveKind' = "none"
  /\ UNCHANGED strictFlag

Done ==
  /\ state \in {"ScanClean", "ScanStrictFlagged"}
  /\ UNCHANGED vars

Next ==
  \/ AddNextLine
  \/ AddRegionDisable
  \/ AddRegionEnable
  \/ RunNormalScan
  \/ RunStrictScan
  \/ ResumeScanAfterRegion
  \/ Done

TypeOK == state \in States

Spec == Init /\ [][Next]_vars
====
