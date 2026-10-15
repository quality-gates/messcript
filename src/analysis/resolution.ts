/** Why the targets may not be the full list: unresolved code, a decorator that can replace them, or both. */
export type Cause = "unresolved" | "decorator" | "both";

export type Resolution<T> =
  | { readonly targets: readonly T[]; readonly complete: true }
  | { readonly targets: readonly T[]; readonly complete: false; readonly cause: Cause };

export function complete<T>(targets: readonly T[]): Resolution<T> {
  return { targets, complete: true };
}

export function unresolved<T>(targets: readonly T[] = []): Resolution<T> {
  return { targets, complete: false, cause: "unresolved" };
}

export function decorated<T>(targets: readonly T[]): Resolution<T> {
  return { targets, complete: false, cause: "decorator" };
}

/** Tells if a decorator can replace some of the targets. */
export function isDecorated<T>(source: Resolution<T>): boolean {
  return !source.complete && source.cause !== "unresolved";
}

/** Tells if unresolved code can supply targets that are not listed. */
export function isUnresolved<T>(source: Resolution<T>): boolean {
  return !source.complete && source.cause !== "decorator";
}

function withCauses<T>(targets: readonly T[], groups: readonly Resolution<unknown>[]): Resolution<T> {
  const decorator = groups.some(isDecorated);
  const open = groups.some(isUnresolved);
  return decorator && open ? { targets, complete: false, cause: "both" }
    : decorator ? decorated(targets) : open ? unresolved(targets) : complete(targets);
}

export function join<T>(groups: readonly Resolution<T>[]): Resolution<T> {
  return withCauses([...new Set(groups.flatMap(group => group.targets))], groups);
}

export function map<T, U>(source: Resolution<T>, select: (target: T) => U): Resolution<U> {
  return withCauses(source.targets.map(select), [source]);
}

/** Gives the result's targets, marked incomplete for any reason the evidence or the result is incomplete. */
export function inherit<T, U>(evidence: Resolution<T>, result: Resolution<U>): Resolution<U> {
  return withCauses(result.targets, [evidence, result]);
}
