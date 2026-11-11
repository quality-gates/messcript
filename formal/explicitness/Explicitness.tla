---- MODULE Explicitness ----
EXTENDS Naturals, Sequences

CONSTANTS NumCallables, MaxRounds

VARIABLES round, summaries, changed, sharedCount, converged, status

vars == <<round, summaries, changed, sharedCount, converged, status>>

\* Summaries track flow count (0..2) per callable
Init ==
  /\ round = 0
  /\ summaries = [c \in 1..NumCallables |-> 0]
  /\ changed = FALSE
  /\ sharedCount = 0
  /\ converged = FALSE
  /\ status = "Iterating"

RoundStep ==
  /\ status = "Iterating"
  /\ round < MaxRounds
  /\ \E nextFlows \in [1..NumCallables -> 0..2] :
       LET willChange == (nextFlows /= summaries)
           nextShared == IF willChange THEN (sharedCount + 1) % 3 ELSE sharedCount
       IN
         /\ summaries' = nextFlows
         /\ changed' = willChange
         /\ sharedCount' = nextShared
         /\ round' = round + 1
         /\ IF ~willChange /\ (nextShared = sharedCount)
            THEN /\ converged' = TRUE
                 /\ status' = "Converged"
            ELSE IF round + 1 = MaxRounds
                 THEN /\ converged' = FALSE
                      /\ status' = "UnconvergedFallback"
                 ELSE /\ converged' = FALSE
                      /\ status' = "Iterating"

Terminated ==
  /\ status \in {"Converged", "UnconvergedFallback"}
  /\ UNCHANGED vars

Next == RoundStep \/ Terminated

TypeOK ==
  /\ round \in 0..MaxRounds
  /\ converged \in BOOLEAN
  /\ status \in {"Iterating", "Converged", "UnconvergedFallback"}

\* Invariant: If UnconvergedFallback, converged must be FALSE (fallback will synthesize unknown effects)
FallbackNeverClaimsPurity == (status = "UnconvergedFallback") => (~converged)

\* Invariant: When converged, status must be Converged
ConvergedStatusConsistent == (converged = TRUE) <=> (status = "Converged")

Spec == Init /\ [][Next]_vars
====
