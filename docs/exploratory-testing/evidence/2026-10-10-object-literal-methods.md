# Object-literal methods skipped by naming rules — 2026-10-10

messcript 0.1.17, built from `c951bf2`. Node v26.7.0. Three fresh directories.

`handlers.ts` declares `Bad_Name`, `ab`, and `getActive` both in an object literal and on class `Screen`.

Each run exited 2. Findings, all on the class methods, none on the object literal:

```text
handlers.ts:1:14: ConstantNamingConventions [priority 4] Constant handlers should be defined in uppercase (context: constant handlers)
handlers.ts:14:3: CamelCaseMethodName [priority 1] The method Bad_Name is not named in camelCase. (context: method Bad_Name())
handlers.ts:17:3: ShortMethodName [priority 3] Avoid using short method names like ab(). The configured minimum method name length is 3. (context: method ab())
handlers.ts:20:3: BooleanGetMethodName [priority 4] The 'getActive()' method which returns a boolean should be named 'is...()' or 'has...()' (context: method getActive())
```

Same three findings on runs 1, 2, and 3.

Separate controls in the same pass: an object-literal method with `else` was reported by `ElseExpression`, and one with nine branches was reported by `CyclomaticComplexity` at 10.

Filed as [#304](https://github.com/quality-gates/messcript/issues/304).
