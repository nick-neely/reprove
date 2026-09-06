/**
 * Turn a title into a lower-case, dash-separated slug.
 *
 * Renamed from `slugify` to `toSlug`; behavior is unchanged.
 */
export const toSlug = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
