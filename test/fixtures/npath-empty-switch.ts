export function plain() {}

export function emptySwitch(value: number) {
  switch (value) {}
}

export function switchThenBranch(value: number) {
  switch (value) {}
  if (value) return 1;
  return 0;
}

export function oneCase(value: number) {
  switch (value) {
    case 1: return 1;
  }
}
