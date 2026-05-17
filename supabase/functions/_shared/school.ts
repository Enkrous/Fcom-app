/**
 * Normalization helpers for school names.
 *
 * Users type school names manually in the UI, so we canonicalize comparisons
 * to avoid accidental isolation caused by case differences or extra spaces.
 */

export function sanitizeSchoolName(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getSchoolKey(value: string): string {
  return sanitizeSchoolName(value).toLowerCase();
}

export function isSameSchool(a: string, b: string): boolean {
  return getSchoolKey(a) !== '' && getSchoolKey(a) === getSchoolKey(b);
}
