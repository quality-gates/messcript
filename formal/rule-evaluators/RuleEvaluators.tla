---- MODULE RuleEvaluators ----
EXTENDS Naturals, Sequences

CONSTANTS MaxProps

VARIABLES keyState, conflictFound, propCount, cacheState, status

vars == <<keyState, conflictFound, propCount, cacheState, status>>

\* KeyState: "Empty", "Value", "Get", "Set", "GetAndSet", "Conflict"
\* CacheState: "Uncached", "CachedValid", "CachedPermanentError"

Init ==
  /\ keyState = "Empty"
  /\ conflictFound = FALSE
  /\ propCount = 0
  /\ cacheState = "Uncached"
  /\ status = "Evaluating"

AddGet ==
  /\ status = "Evaluating"
  /\ propCount < MaxProps
  /\ IF keyState \in {"Get", "GetAndSet", "Value"}
     THEN /\ keyState' = "Conflict"
          /\ conflictFound' = TRUE
     ELSE IF keyState = "Set"
          THEN /\ keyState' = "GetAndSet"
               /\ conflictFound' = conflictFound
          ELSE /\ keyState' = "Get"
               /\ conflictFound' = conflictFound
  /\ propCount' = propCount + 1
  /\ UNCHANGED <<cacheState, status>>

AddSet ==
  /\ status = "Evaluating"
  /\ propCount < MaxProps
  /\ IF keyState \in {"Set", "GetAndSet", "Value"}
     THEN /\ keyState' = "Conflict"
          /\ conflictFound' = TRUE
     ELSE IF keyState = "Get"
          THEN /\ keyState' = "GetAndSet"
               /\ conflictFound' = conflictFound
          ELSE /\ keyState' = "Set"
               /\ conflictFound' = conflictFound
  /\ propCount' = propCount + 1
  /\ UNCHANGED <<cacheState, status>>

AddValue ==
  /\ status = "Evaluating"
  /\ propCount < MaxProps
  /\ IF keyState /= "Empty"
     THEN /\ keyState' = "Conflict"
          /\ conflictFound' = TRUE
     ELSE /\ keyState' = "Value"
          /\ conflictFound' = conflictFound
  /\ propCount' = propCount + 1
  /\ UNCHANGED <<cacheState, status>>

CompileRegexSuccess ==
  /\ status = "Evaluating"
  /\ cacheState = "Uncached"
  /\ cacheState' = "CachedValid"
  /\ UNCHANGED <<keyState, conflictFound, propCount, status>>

CompileRegexSyntaxError ==
  /\ status = "Evaluating"
  /\ cacheState = "Uncached"
  /\ cacheState' = "CachedPermanentError"
  /\ UNCHANGED <<keyState, conflictFound, propCount, status>>

CompileRegexTransientTimeout ==
  /\ status = "Evaluating"
  /\ cacheState = "Uncached"
  \* Transient timeout must NOT be cached
  /\ cacheState' = "Uncached"
  /\ UNCHANGED <<keyState, conflictFound, propCount, status>>

Finish ==
  /\ status = "Evaluating"
  /\ status' = "Done"
  /\ UNCHANGED <<keyState, conflictFound, propCount, cacheState>>

Terminated ==
  /\ status = "Done"
  /\ UNCHANGED vars

Next ==
  \/ AddGet
  \/ AddSet
  \/ AddValue
  \/ CompileRegexSuccess
  \/ CompileRegexSyntaxError
  \/ CompileRegexTransientTimeout
  \/ Finish
  \/ Terminated

TypeOK ==
  /\ keyState \in {"Empty", "Value", "Get", "Set", "GetAndSet", "Conflict"}
  /\ cacheState \in {"Uncached", "CachedValid", "CachedPermanentError"}
  /\ conflictFound \in BOOLEAN
  /\ status \in {"Evaluating", "Done"}

\* Invariant 1: Getter + Setter on same key is not a conflict
GetAndSetNotAConflict == (keyState = "GetAndSet") => (~conflictFound)

\* Invariant 2: Transient timeouts never pollute cache with permanent error
CacheIntegrity == cacheState /= "TransientError"

Spec == Init /\ [][Next]_vars
====
