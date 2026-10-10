# LackOfCohesionOfMethods bare identifier — 2026-10-10

messcript 0.1.17, built from `c951bf2`. Node v26.7.0. Three fresh directories.

Bug file `bag.ts`: `bumpRight` returns the free identifier `left`. Control writes `this.right`.

| Run | bug exit | bug findings | control exit | control finding |
|---|---:|---|---:|---|
| 1 | 0 | none | 2 | LCOM4 value of 2 on class Bag |
| 2 | 0 | none | 2 | LCOM4 value of 2 on class Bag |
| 3 | 0 | none | 2 | LCOM4 value of 2 on class Bag |

Command: `node dist/cli.js bag.ts text design --only LackOfCohesionOfMethods`.

Filed as [#303](https://github.com/quality-gates/messcript/issues/303).
