/** Distinguish activated source authority from counters that may start at zero. */
export function validActivatedSourceRevision(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validNonnegativeAuthorityCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
