# Evidence — naming rules report once per TypeScript overload signature

messcript 0.1.8, built from `34cfcdd`. Node v26.7.0.

## Fixture `ovl.ts`

```ts
export function ov(a: string): string;
export function ov(a: number): number;
export function ov(a: unknown): unknown { return a; }
```

One function named `ov`.

## Run 1

```console
$ node dist/cli.js ovl.ts text typescript --only ShortMethodName
ovl.ts:1:1: ShortMethodName [priority 3] Avoid using short method names like ov(). The configured minimum method name length is 3. (context: function ov())
ovl.ts:2:1: ShortMethodName [priority 3] Avoid using short method names like ov(). The configured minimum method name length is 3. (context: function ov())
ovl.ts:3:1: ShortMethodName [priority 3] Avoid using short method names like ov(). The configured minimum method name length is 3. (context: function ov())
EXIT=2
```

## Run 2 — identical repeat

Same three lines, exit 2.

## Suppressing needs one directive per signature

```ts
// messcript-disable-next-line ShortMethodName
export function ov(a: string): string;
export function ov(a: number): number;
export function ov(a: unknown): unknown { return a; }
```

```console
ovl2.ts:3:1: ShortMethodName ... (context: function ov())
ovl2.ts:4:1: ShortMethodName ... (context: function ov())
EXIT=2
```

## Contrast — metric rules do skip overload signatures

```ts
export function many(a1:number,/* ...through a10 */): void;
export function many(b1:string,/* ...through b10 */): void;
export function many(...args: any[]): void { void args; }
```

```console
$ node dist/cli.js ovl-params.ts text codesize --only ExcessiveParameterList
EXIT=0
```

`ShortVariable` behaves like `ShortMethodName`: parameter `a` is reported three
times, once per signature.
