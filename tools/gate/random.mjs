/**
 * A deterministic random source, seeded from evaluation identity.
 *
 * Issue #34 fixes the bootstrap seed as "derived from evaluation identity", so
 * two maintainers scoring the same trial matrix under the same versions must
 * see the same interval to the last digit. `Math.random` cannot promise that;
 * sfc32 over a SHA-256 of the identity string can. It is also what shuffles the
 * batch, for the same reason: an interleaving that cannot be reproduced cannot
 * be audited.
 */
import { createHash } from "node:crypto";

/*
 * sfc32 is *defined* over 32-bit integer operations: the shifts, the xor and
 * the `| 0` wraparound are the algorithm, not a bit-twiddling shortcut for
 * arithmetic someone could write with `Math.trunc`. Rewriting them would
 * change the stream, and the stream is what makes a score reproducible.
 */
/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc */

/**
 * @param {string} identity Anything that names the evaluation exactly.
 * @returns {() => number} Uniform numbers in [0, 1).
 */
export const seededRandom = (identity) => {
  const digest = createHash("sha256").update(identity).digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  const draw = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };
  // sfc32 needs a few rounds to mix a low-entropy state; a digest is not one,
  // but the discard is cheap and keeps the generator's published behaviour.
  for (let index = 0; index < 12; index += 1) {
    draw();
  }
  return draw;
};

/**
 * Fisher-Yates over a copy, driven by the seeded source.
 *
 * @template T
 * @param {readonly T[]} items What to shuffle.
 * @param {() => number} random The seeded source.
 * @returns {T[]} A new array in shuffled order.
 */
export const shuffle = (items, random) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = shuffled[index];
    shuffled[index] = shuffled[other];
    shuffled[other] = held;
  }
  return shuffled;
};
