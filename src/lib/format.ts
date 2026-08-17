export const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
  "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII", "XXIII", "XXIV",
];

/** Roman by default; the design exposes an arabic switch. */
export function numeral(i: number, arabic = false): string {
  if (arabic) return String(i + 1);
  return ROMAN[i] ?? String(i + 1);
}

/** 45 → "45 min", 120 → "2 hr", 90 → "1 hr 30 min". */
export function fmt(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** Wrap a token name as a CSS var reference. */
export const C = (token: string) => `var(${token})`;

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
