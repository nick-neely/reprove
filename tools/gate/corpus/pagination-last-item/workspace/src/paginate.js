/**
 * Slice one page out of a list.
 *
 * Pages are 1-based; `size` is the number of items per page.
 */
const MAX_SIZE = 100;

export const paginate = (items, page, size) => {
  const bounded = Math.min(size, MAX_SIZE);
  const start = (page - 1) * bounded;
  const end = start + bounded - 1;
  return items.slice(start, end);
};

export const pageCount = (items, size) =>
  Math.ceil(items.length / Math.min(size, MAX_SIZE));
