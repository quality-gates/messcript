export function complex(value: number): number {
  let result = value;

  if (value > 0) {
    result += 1;
  } else if (value === 0) {
    result -= 1;
  }

  for (let index = 0; index < value; index += 1) {
    result += index;
  }

  while (result < value * 2) {
    result += 1;
  }

  do {
    result -= 1;
  } while (result > value);

  switch (value) {
    case 1:
      result += 1;
      break;
    case 2:
      result += 2;
      break;
    case 3:
      result += 3;
      break;
    default:
      result += 4;
  }

  try {
    result += 1;
  } catch {
    result -= 1;
  }

  return (value > 2 ? value && result : value) ?? 1;
}

