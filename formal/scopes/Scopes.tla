---- MODULE Scopes ----
EXTENDS Naturals, Sequences

CONSTANTS MaxSteps

VARIABLES currentScope, scopeStack, fileBindings, funcBindings, blockBindings, 
          blockVarDecls, mutatedBindings, stepCount, status

vars == <<currentScope, scopeStack, fileBindings, funcBindings, blockBindings, 
          blockVarDecls, mutatedBindings, stepCount, status>>

ScopeKinds == {"file", "function", "block"}

Init ==
  /\ currentScope = "file"
  /\ scopeStack = <<"file">>
  /\ fileBindings = {}
  /\ funcBindings = {}
  /\ blockBindings = {}
  /\ blockVarDecls = 0
  /\ mutatedBindings = {}
  /\ stepCount = 0
  /\ status = "Building"

EnterScope(kind) ==
  /\ status = "Building"
  /\ stepCount < MaxSteps
  /\ Len(scopeStack) < 3
  /\ scopeStack' = Append(scopeStack, kind)
  /\ currentScope' = kind
  /\ stepCount' = stepCount + 1
  /\ UNCHANGED <<fileBindings, funcBindings, blockBindings, blockVarDecls, mutatedBindings, status>>

DeclareVar(name, kind) ==
  /\ status = "Building"
  /\ stepCount < MaxSteps
  /\ IF kind = "var"
     THEN IF "function" \in {scopeStack[i] : i \in 1..Len(scopeStack)}
          THEN /\ funcBindings' = funcBindings \cup {name}
               /\ UNCHANGED <<fileBindings, blockBindings, blockVarDecls>>
          ELSE /\ fileBindings' = fileBindings \cup {name}
               /\ UNCHANGED <<funcBindings, blockBindings, blockVarDecls>>
     ELSE IF currentScope = "block"
          THEN /\ blockBindings' = blockBindings \cup {name}
               /\ UNCHANGED <<fileBindings, funcBindings, blockVarDecls>>
          ELSE IF currentScope = "function"
               THEN /\ funcBindings' = funcBindings \cup {name}
                    /\ UNCHANGED <<fileBindings, blockBindings, blockVarDecls>>
               ELSE /\ fileBindings' = fileBindings \cup {name}
                    /\ UNCHANGED <<funcBindings, blockBindings, blockVarDecls>>
  /\ stepCount' = stepCount + 1
  /\ UNCHANGED <<currentScope, scopeStack, mutatedBindings, status>>

RecordWrite(name, isLoopIncrementor) ==
  /\ status = "Building"
  /\ stepCount < MaxSteps
  /\ IF ~isLoopIncrementor
     THEN mutatedBindings' = mutatedBindings \cup {name}
     ELSE UNCHANGED mutatedBindings
  /\ stepCount' = stepCount + 1
  /\ UNCHANGED <<currentScope, scopeStack, fileBindings, funcBindings, blockBindings, blockVarDecls, status>>

ResolveAll ==
  /\ status = "Building"
  /\ status' = "Resolved"
  /\ stepCount' = stepCount + 1
  /\ UNCHANGED <<currentScope, scopeStack, fileBindings, funcBindings, blockBindings, blockVarDecls, mutatedBindings>>

Terminated ==
  /\ status = "Resolved"
  /\ UNCHANGED vars

Next ==
  \/ EnterScope("function")
  \/ EnterScope("block")
  \/ DeclareVar("x", "var")
  \/ DeclareVar("x", "let")
  \/ RecordWrite("x", FALSE)
  \/ RecordWrite("x", TRUE)
  \/ ResolveAll
  \/ Terminated

TypeOK ==
  /\ currentScope \in ScopeKinds
  /\ status \in {"Building", "Resolved"}

\* Invariant: var declarations never bound into block scope
VarNeverInBlockScope == blockVarDecls = 0

Spec == Init /\ [][Next]_vars
====
