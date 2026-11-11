---- MODULE CliDiscovery ----
EXTENDS Naturals, Sequences, FiniteSets

VARIABLES phase, hasErrors, hasViolations, ignoreErrors, ignoreViolations, 
          visitedInodes, currentInode, exitCode

vars == <<phase, hasErrors, hasViolations, ignoreErrors, ignoreViolations, 
          visitedInodes, currentInode, exitCode>>

Phases == {"Args", "Discovering", "Analyzing", "Exiting", "Terminated"}

Init ==
  /\ phase = "Args"
  /\ hasErrors = FALSE
  /\ hasViolations = FALSE
  /\ ignoreErrors \in BOOLEAN
  /\ ignoreViolations \in BOOLEAN
  /\ visitedInodes = {}
  /\ currentInode = 1
  /\ exitCode = 99

ParseArgs ==
  /\ phase = "Args"
  /\ phase' = "Discovering"
  /\ UNCHANGED <<hasErrors, hasViolations, ignoreErrors, ignoreViolations, visitedInodes, currentInode, exitCode>>

VisitDirectory(inode) ==
  /\ phase = "Discovering"
  /\ IF inode \in visitedInodes
     THEN /\ phase' = "Analyzing"
          /\ UNCHANGED <<visitedInodes, currentInode, hasErrors>>
     ELSE /\ visitedInodes' = visitedInodes \cup {inode}
          /\ currentInode' = (inode % 3) + 1
          /\ phase' = IF Cardinality(visitedInodes \cup {inode}) >= 2 THEN "Analyzing" ELSE "Discovering"
          /\ UNCHANGED hasErrors
  /\ UNCHANGED <<hasViolations, ignoreErrors, ignoreViolations, exitCode>>

DiscoveryError ==
  /\ phase = "Discovering"
  /\ hasErrors' = TRUE
  /\ phase' = "Exiting"
  /\ UNCHANGED <<hasViolations, ignoreErrors, ignoreViolations, visitedInodes, currentInode, exitCode>>

Analyze(withViolations) ==
  /\ phase = "Analyzing"
  /\ hasViolations' = withViolations
  /\ phase' = "Exiting"
  /\ UNCHANGED <<hasErrors, ignoreErrors, ignoreViolations, visitedInodes, currentInode, exitCode>>

ComputeExitCode ==
  /\ phase = "Exiting"
  /\ IF hasErrors /\ ~ignoreErrors
     THEN exitCode' = 1
     ELSE IF hasViolations /\ ~ignoreViolations
          THEN exitCode' = 2
          ELSE exitCode' = 0
  /\ phase' = "Terminated"
  /\ UNCHANGED <<hasErrors, hasViolations, ignoreErrors, ignoreViolations, visitedInodes, currentInode>>

TerminatedAction ==
  /\ phase = "Terminated"
  /\ UNCHANGED vars

Next ==
  \/ ParseArgs
  \/ (\E i \in 1..3 : VisitDirectory(i))
  \/ DiscoveryError
  \/ Analyze(TRUE)
  \/ Analyze(FALSE)
  \/ ComputeExitCode
  \/ TerminatedAction

TypeOK ==
  /\ phase \in Phases
  /\ exitCode \in {0, 1, 2, 99}
  /\ (phase = "Terminated") => (exitCode \in {0, 1, 2})

Code2Contract == (exitCode = 2) => (hasViolations /\ (~hasErrors \/ ignoreErrors))
ErrorPrecedence == (phase = "Terminated" /\ hasErrors /\ ~ignoreErrors) => (exitCode = 1)

Spec == Init /\ [][Next]_vars
====
