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

const FIZTEX = 'Fiztex';

const SCHOOL_ALIASES: Record<string, string> = {
  'fiztex': FIZTEX,
  'fiztekh': FIZTEX,
  'phystech': FIZTEX,
  '\u0444\u0438\u0437\u0442\u0435\u0445': FIZTEX,
};

export function getCanonicalSchoolName(value: string): string {
  const sanitized = sanitizeSchoolName(value);
  if (!sanitized) return '';

  const alias = SCHOOL_ALIASES[sanitized.toLowerCase()];
  return alias ?? sanitized;
}

export function getSchoolKey(value: string): string {
  return getCanonicalSchoolName(value).toLowerCase();
}

export function isSameSchool(a: string, b: string): boolean {
  return getSchoolKey(a) !== '' && getSchoolKey(a) === getSchoolKey(b);
}
