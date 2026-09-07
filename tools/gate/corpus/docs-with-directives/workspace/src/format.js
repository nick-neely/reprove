/**
 * Format a finite number with grouping separators for `locale`.
 *
 * Non-finite input is rejected rather than rendered as `NaN`.
 */
export const formatNumber = (value, locale = "en-US") => {
  if (!Number.isFinite(value)) {
    throw new RangeError("value must be finite");
  }
  return value.toLocaleString(locale);
};
