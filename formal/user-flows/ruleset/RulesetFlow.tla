---- MODULE RulesetFlow ----
EXTENDS Naturals, Sequences

VARIABLES state, hasCycle, hasInvalidSyntax

vars == <<state, hasCycle, hasInvalidSyntax>>

States == {
  "DraftingXmlRuleset",
  "ReferencingBaseSet",
  "ConfiguringExclusions",
  "OverridingThresholds",
  "ValidatingXmlAndCycles",
  "ActiveCustomPolicy",
  "ConfigurationFailed"
}

Init ==
  /\ state = "DraftingXmlRuleset"
  /\ hasCycle \in BOOLEAN
  /\ hasInvalidSyntax \in BOOLEAN

ReferenceBase ==
  /\ state = "DraftingXmlRuleset"
  /\ state' = "ReferencingBaseSet"
  /\ UNCHANGED <<hasCycle, hasInvalidSyntax>>

AddExclusion ==
  /\ state = "ReferencingBaseSet"
  /\ state' = "ConfiguringExclusions"
  /\ UNCHANGED <<hasCycle, hasInvalidSyntax>>

OverrideThreshold ==
  /\ state = "ConfiguringExclusions"
  /\ state' = "OverridingThresholds"
  /\ UNCHANGED <<hasCycle, hasInvalidSyntax>>

Validate ==
  /\ state \in {"ReferencingBaseSet", "ConfiguringExclusions", "OverridingThresholds"}
  /\ state' = "ValidatingXmlAndCycles"
  /\ UNCHANGED <<hasCycle, hasInvalidSyntax>>

ValidationSucceeds ==
  /\ state = "ValidatingXmlAndCycles"
  /\ ~hasCycle
  /\ ~hasInvalidSyntax
  /\ state' = "ActiveCustomPolicy"
  /\ UNCHANGED <<hasCycle, hasInvalidSyntax>>

ValidationFails ==
  /\ state = "ValidatingXmlAndCycles"
  /\ (hasCycle \/ hasInvalidSyntax)
  /\ state' = "ConfigurationFailed"
  /\ UNCHANGED <<hasCycle, hasInvalidSyntax>>

Done ==
  /\ state \in {"ActiveCustomPolicy", "ConfigurationFailed"}
  /\ UNCHANGED vars

Next ==
  \/ ReferenceBase
  \/ AddExclusion
  \/ OverrideThreshold
  \/ Validate
  \/ ValidationSucceeds
  \/ ValidationFails
  \/ Done

TypeOK == state \in States

Spec == Init /\ [][Next]_vars
====
