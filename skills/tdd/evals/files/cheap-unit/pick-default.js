export function pickDefault(value, fallback) {
  if (value == null) return fallback;
  return value;
}
