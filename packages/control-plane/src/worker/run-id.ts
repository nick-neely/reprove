/**
 * What a Run id looks like, checked before it reaches a `uuid` column.
 *
 * The protocol schemas deliberately do **not** enforce this: `runId` is an
 * opaque string on the wire, and pinning the wire to Postgres's column type
 * would make a storage decision part of a contract a four-month-old Worker
 * depends on. So the shape is checked on this side, where the column is, and it
 * is checked in **one** place because both paths that take a Run id from a
 * Worker need exactly the same guard.
 *
 * Without it a Worker naming `not-a-uuid` reaches Postgres, which raises
 * `22P02 invalid input syntax for type uuid` from inside the statement - and a
 * Worker endpoint reports that rolled-back transaction as `503`, telling the
 * Worker the control plane is unavailable when what actually happened is that
 * it named a Run that cannot exist. Both callers answer `unknown_run` instead,
 * which is the same answer that Owner gets for any other id it does not hold.
 */
const RUN_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/**
 * Whether a Worker-supplied Run id is one this schema could hold.
 *
 * @param runId The id as it arrived, unvalidated.
 * @returns Whether it is shaped like the `uuid` column it would be compared to.
 */
export const isRunId = (runId: string): boolean => RUN_ID.test(runId);
