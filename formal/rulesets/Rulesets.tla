---- MODULE Rulesets ----
EXTENDS Naturals, Sequences

CONSTANTS MaxDepth, MaxSteps

VARIABLES stack, rootExists, status, stepCount, fileStack, cycleDetected

vars == <<stack, rootExists, status, stepCount, fileStack, cycleDetected>>

TagNames == {"ruleset", "rule"}
FileNames == {"main.xml", "base.xml"}

Init ==
  /\ stack = <<>>
  /\ rootExists = FALSE
  /\ status = "Parsing"
  /\ stepCount = 0
  /\ fileStack = {"main.xml"}
  /\ cycleDetected = FALSE

OpenTag(tag) ==
  /\ status = "Parsing"
  /\ stepCount < MaxSteps
  /\ Len(stack) < MaxDepth
  /\ IF Len(stack) = 0
     THEN /\ rootExists' = TRUE
          /\ stack' = Append(stack, tag)
     ELSE /\ rootExists' = rootExists
          /\ stack' = Append(stack, tag)
  /\ status' = "Parsing"
  /\ stepCount' = stepCount + 1
  /\ UNCHANGED <<fileStack, cycleDetected>>

CloseTag(tag) ==
  /\ status = "Parsing"
  /\ stepCount < MaxSteps
  /\ Len(stack) > 0
  /\ IF stack[Len(stack)] = tag
     THEN /\ stack' = SubSeq(stack, 1, Len(stack) - 1)
          /\ status' = IF Len(stack) = 1 THEN "Done" ELSE "Parsing"
          /\ UNCHANGED <<rootExists, fileStack, cycleDetected>>
     ELSE /\ status' = "ParseError"
          /\ UNCHANGED <<stack, rootExists, fileStack, cycleDetected>>
  /\ stepCount' = stepCount + 1

ExpandFile(file) ==
  /\ status \in {"Parsing", "Done"}
  /\ stepCount < MaxSteps
  /\ IF file \in fileStack
     THEN /\ cycleDetected' = TRUE
          /\ status' = "CycleError"
          /\ UNCHANGED fileStack
     ELSE /\ fileStack' = fileStack \cup {file}
          /\ UNCHANGED cycleDetected
          /\ status' = status
  /\ stepCount' = stepCount + 1
  /\ UNCHANGED <<stack, rootExists>>

StepLimit ==
  /\ status = "Parsing"
  /\ stepCount = MaxSteps
  /\ status' = "Timeout"
  /\ UNCHANGED <<stack, rootExists, fileStack, cycleDetected, stepCount>>

Terminated ==
  /\ status \in {"Done", "ParseError", "CycleError", "Timeout"}
  /\ UNCHANGED vars

Next ==
  \/ (\E t \in TagNames : OpenTag(t))
  \/ (\E t \in TagNames : CloseTag(t))
  \/ (\E f \in FileNames : ExpandFile(f))
  \/ StepLimit
  \/ Terminated

TypeOK ==
  /\ Len(stack) <= MaxDepth
  /\ rootExists \in BOOLEAN
  /\ status \in {"Parsing", "Done", "ParseError", "CycleError", "Timeout"}
  /\ cycleDetected \in BOOLEAN

DoneImpliesEmptyStack == (status = "Done") => (Len(stack) = 0)
CycleCaught == cycleDetected => (status = "CycleError")

Spec == Init /\ [][Next]_vars
====
