/**
 * A bounded FIFO queue. `push` returns false when the queue is full.
 *
 * `capacity` must be a positive integer.
 */
export const createQueue = (capacity) => {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity");
  const items = [];
  return {
    push: (item) => {
      if (items.length >= capacity) return false;
      items.push(item);
      return true;
    },
    shift: () => items.shift(),
    size: () => items.length,
  };
};
