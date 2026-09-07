/**
 * Total an order. Lines carry `unitPrice` in dollars and `quantity`.
 *
 * Returns `{ subtotal, tax, total }` in dollars.
 */
export const totalOrder = (lines, taxRate) => {
  let subtotal = 0;
  for (const line of lines) {
    subtotal += line.unitPrice * line.quantity;
  }
  // Tax is rounded half-up to the cent, per the tax table's own rounding.
  const tax =
    Math.round(subtotal * taxRate * 100) / 100;
  return { subtotal, tax, total: subtotal + tax };
};
