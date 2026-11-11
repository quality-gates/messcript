---- MODULE ScanFlow ----
EXTENDS Naturals, Sequences

VARIABLES stage, findingsCount, errorCount, strictMode, exitCode

vars == <<stage, findingsCount, errorCount, strictMode, exitCode>>

Stages == {
  "Idle",
  "ParsingArguments",
  "DiscoveringFiles",
  "LoadingRulesets",
  "AnalyzingAST",
  "ApplyingSuppressions",
  "FormattingReport",
  "Completed"
}

Init ==
  /\ stage = "Idle"
  /\ findingsCount = 0
  /\ errorCount = 0
  /\ strictMode \in BOOLEAN
  /\ exitCode = 99

YouRunMesscript ==
  /\ stage = "Idle"
  /\ stage' = "ParsingArguments"
  /\ UNCHANGED <<findingsCount, errorCount, strictMode, exitCode>>

ArgsParsed ==
  /\ stage = "ParsingArguments"
  /\ stage' = "DiscoveringFiles"
  /\ UNCHANGED <<findingsCount, errorCount, strictMode, exitCode>>

FilesDiscovered ==
  /\ stage = "DiscoveringFiles"
  /\ stage' = "LoadingRulesets"
  /\ UNCHANGED <<findingsCount, errorCount, strictMode, exitCode>>

RulesetsLoaded ==
  /\ stage = "LoadingRulesets"
  /\ stage' = "AnalyzingAST"
  /\ UNCHANGED <<findingsCount, errorCount, strictMode, exitCode>>

ASTAnalyzedClean ==
  /\ stage = "AnalyzingAST"
  /\ findingsCount' = 0
  /\ errorCount' = 0
  /\ stage' = "ApplyingSuppressions"
  /\ UNCHANGED <<strictMode, exitCode>>

ASTAnalyzedWithFindings ==
  /\ stage = "AnalyzingAST"
  /\ findingsCount' = 2
  /\ errorCount' = 0
  /\ stage' = "ApplyingSuppressions"
  /\ UNCHANGED <<strictMode, exitCode>>

ParseErrorEncountered ==
  /\ stage = "AnalyzingAST"
  /\ errorCount' = 1
  /\ stage' = "FormattingReport"
  /\ UNCHANGED <<findingsCount, strictMode, exitCode>>

SuppressionsApplied ==
  /\ stage = "ApplyingSuppressions"
  /\ IF ~strictMode /\ findingsCount > 0
     THEN findingsCount' = 0
     ELSE findingsCount' = findingsCount
  /\ stage' = "FormattingReport"
  /\ UNCHANGED <<errorCount, strictMode, exitCode>>

ReportFormatted ==
  /\ stage = "FormattingReport"
  /\ IF errorCount > 0
     THEN exitCode' = 1
     ELSE IF findingsCount > 0
          THEN exitCode' = 2
          ELSE exitCode' = 0
  /\ stage' = "Completed"
  /\ UNCHANGED <<findingsCount, errorCount, strictMode>>

Done ==
  /\ stage = "Completed"
  /\ UNCHANGED vars

Next ==
  \/ YouRunMesscript
  \/ ArgsParsed
  \/ FilesDiscovered
  \/ RulesetsLoaded
  \/ ASTAnalyzedClean
  \/ ASTAnalyzedWithFindings
  \/ ParseErrorEncountered
  \/ SuppressionsApplied
  \/ ReportFormatted
  \/ Done

TypeOK == stage \in Stages

Spec == Init /\ [][Next]_vars
====
