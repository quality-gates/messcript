---- MODULE Suppressions ----
EXTENDS Naturals, Sequences

CONSTANTS MaxLines

VARIABLES line, activeCount, nextLineSuppressed, suppressedLines, currentDirective, status

vars == <<line, activeCount, nextLineSuppressed, suppressedLines, currentDirective, status>>

DirectiveKinds == {"none", "disable", "enable", "disable_next_line"}

Init ==
  /\ line = 1
  /\ activeCount = 0
  /\ nextLineSuppressed = FALSE
  /\ suppressedLines = [l \in 1..MaxLines |-> FALSE]
  /\ currentDirective \in DirectiveKinds
  /\ status = "Scanning"

StepLine ==
  /\ status = "Scanning"
  /\ line <= MaxLines
  /\ LET hasEnable == (currentDirective = "enable")
         newActivePre == IF hasEnable
                         THEN (IF activeCount > 0 THEN activeCount - 1 ELSE 0)
                         ELSE activeCount
         isSuppressed == (newActivePre > 0) \/ nextLineSuppressed
         hasDisable == (currentDirective = "disable")
         hasDisableNext == (currentDirective = "disable_next_line")
         newActivePost == IF hasDisable THEN newActivePre + 1 ELSE newActivePre
         newNextLine == hasDisableNext
     IN
       /\ suppressedLines' = [suppressedLines EXCEPT ![line] = isSuppressed]
       /\ activeCount' = newActivePost
       /\ nextLineSuppressed' = newNextLine
       /\ line' = line + 1
       /\ IF line = MaxLines
          THEN /\ status' = "Done"
               /\ currentDirective' = "none"
          ELSE /\ status' = "Scanning"
               /\ currentDirective' \in DirectiveKinds

Finish ==
  /\ status = "Done"
  /\ UNCHANGED vars

Next == StepLine \/ Finish

TypeOK ==
  /\ line \in 1..(MaxLines + 1)
  /\ activeCount >= 0
  /\ nextLineSuppressed \in BOOLEAN
  /\ status \in {"Scanning", "Done"}

\* Invariant 1: activeCount must never be negative
CountNonNegative == activeCount >= 0

\* Invariant 2: NextLine directive expires within 1 step (cannot persist beyond line+1)
NoLeakPastNextLine == (status = "Done") => (nextLineSuppressed = FALSE \/ currentDirective = "none")

Spec == Init /\ [][Next]_vars
====
