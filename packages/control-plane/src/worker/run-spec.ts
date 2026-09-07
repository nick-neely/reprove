/**
 * The claimed Run, as the `RunSpec` a Worker executes from.
 *
 * The spec is "fixed when the control plane creates a Run and sent unchanged to
 * a Worker", so nothing here decides anything: it reads the row the claim just
 * wrote, reads the one field that does not live on it, and renders both into
 * the protocol's shape.
 *
 * **It is parsed through `runSpecSchema` before it is returned**, rather than
 * asserted to be one. The control plane is the authoritative side of this seam
 * and a Worker has no way to tell a malformed spec from a hostile one, so a
 * spec that would not validate is a defect this module raises rather than
 * something the Worker discovers a Sandbox later. That is also the literal
 * acceptance criterion: a claim returns a **valid** `RunSpec`.
 *
 * Every identifier crosses as a string. `ownerId`, `repositoryId` and
 * `installationId` are GitHub's numeric ids and all three exceed what JSON's
 * number type carries safely in general, so the protocol takes them as strings
 * and the conversion happens here at the seam rather than anywhere a comparison
 * could be made against the number.
 */
import type { RunSpec } from "@reprove/protocol/v1";
import { runSpecSchema } from "@reprove/protocol/v1";
import { and, eq } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import * as schema from "../db/schema.js";

/** The columns of the Run the claim returned, which are its whole spec. */
export interface ClaimedRunRow {
  readonly id: string;
  readonly ownerId: number;
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly provenance: string;
  readonly provenanceBasis: unknown;
  readonly trigger: string;
  readonly placement: string;
  readonly allowHostedFallback: boolean;
  readonly harness: string;
  readonly model: string;
  readonly strategy: string;
  readonly autonomy: string;
  readonly resolvedConfig: unknown;
  readonly configDigest: string;
  readonly claimableUntil: Date;
  readonly createdAt: Date;
}

/**
 * Reads the Installation the Run's Repository was last recorded under.
 *
 * It is not on the Run, because ADR 0008 makes an Installation "a live grant"
 * that may be removed and re-added while the Owner survives - so a Run pins the
 * Repository and the grant is read at the moment a Worker needs one.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param row The claimed Run.
 * @returns The Installation id, or `null` where the Repository records none.
 */
const installationOf = async (
  tx: TenantTransaction,
  row: ClaimedRunRow
): Promise<number | null> => {
  const [repository] = await tx
    .select({ installationId: schema.repository.installationId })
    .from(schema.repository)
    .where(
      and(
        eq(schema.repository.ownerId, row.ownerId),
        eq(schema.repository.id, row.repositoryId)
      )
    )
    .limit(1);
  return repository?.installationId ?? null;
};

/**
 * Renders the claimed Run as the spec its Worker executes from.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param row The Run the conditional UPDATE returned.
 * @returns The parsed `RunSpec`.
 * @throws {Error} When the Repository records no live Installation, or when the
 *   row does not render a valid spec. Neither is caught, and that is the point:
 *   the claim and this render share one transaction, so a throw is what
 *   **un-claims** the Run rather than leaving it claimed by an execution that
 *   was never given a spec.
 *
 *   The ordinary `installation_unavailable` is not this path. The claim's own
 *   predicate excludes a Repository with no Installation, so that Run stays
 *   `queued` and the re-probe names the refusal without anything being written.
 *   What reaches here is the narrow race in which the grant was removed between
 *   the two statements, which is a `503` rather than a named refusal because
 *   nothing about the Run itself is wrong.
 */
export const runSpecOf = async (
  tx: TenantTransaction,
  row: ClaimedRunRow
): Promise<RunSpec> => {
  const installationId = await installationOf(tx, row);
  if (installationId === null) {
    throw new Error(
      `Run ${row.id} is claimable and its Repository records no Installation, so no Workspace could be materialized`
    );
  }

  const parsed = runSpecSchema.safeParse({
    runId: row.id,
    ownerId: String(row.ownerId),
    repositoryId: String(row.repositoryId),
    installationId: String(installationId),
    pullRequestNumber: row.pullRequestNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    provenance: row.provenance,
    provenanceBasis: row.provenanceBasis,
    trigger: row.trigger,
    placement: row.placement,
    allowHostedFallback: row.allowHostedFallback,
    harness: row.harness,
    model: row.model,
    strategy: row.strategy,
    autonomy: row.autonomy,
    resolvedConfig: row.resolvedConfig,
    configDigest: row.configDigest,
    claimableUntil: row.claimableUntil.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
  if (!parsed.success) {
    throw new Error(
      `Run ${row.id} does not render a valid RunSpec: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
};
