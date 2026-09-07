/**
 * Run `operation` up to `attempts` times, waiting `delayMs` between tries.
 *
 * The last error is rethrown when every attempt fails.
 */
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async (operation, { attempts = 3, delayMs = 10 } = {}) => {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }
  let lastError;
  // eslint-disable-next-line no-await-in-loop -- sequential by design
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
};
