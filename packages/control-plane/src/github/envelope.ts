/**
 * The bounded normalized envelope, and nothing that would need retaining.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * is explicit that **the envelope is bounded and normalized, never the raw
 * body**: it carries durable locator and trigger facts only, because the pull
 * request's actual state is fetched canonically later and persisting the raw
 * body would durably duplicate pull request narrative and other
 * repository-derived content - a retention surface ADR 0008 would then have to
 * govern, for facts that are re-fetched anyway. Recording only the delivery GUID
 * and a state was rejected too: that proves *something* arrived without
 * preserving enough to reconstruct what.
 *
 * The payload is **parsed at this boundary** rather than read field by field
 * with runtime type checks. A webhook body is the least trusted input the system
 * takes, and a schema is the difference between a locator that was validated and
 * one that merely looked right at the property access that read it. The parse
 * happens strictly *after* the signature check, because ADR 0013 verifies
 * against the exact received bytes and a value parsed ahead of that invites
 * hashing a re-serialization of it.
 *
 * Nothing in here is trusted as authority for a Run. It is a locator and a
 * trigger, and the canonical fetch in `client.ts` is what a Run is built from.
 */
import { z } from "zod";

import type { OwnerType } from "../db/schema-values.js";

/**
 * The bound is the same one `withOwner` applies to an Owner id: a value past
 * 2^53 has already lost digits by the time it is a JavaScript number, so
 * accepting one would persist a different id than arrived.
 */
const githubIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** GitHub writes `User` and `Organization`; the schema holds the lower-cased pair. */
const accountSchema = z.object({
  id: githubIdSchema,
  login: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
});

/**
 * Everything the envelope can be read from, and deliberately nothing else.
 * Unrecognised keys are dropped rather than rejected: GitHub adds fields to a
 * payload without warning, and a strict object here would turn every such
 * addition into a delivery Reprove refuses to record.
 */
const payloadSchema = z.object({
  action: z.string().min(1).optional(),
  number: githubIdSchema.optional(),
  installation: z
    .object({
      id: githubIdSchema.optional(),
      account: accountSchema.optional(),
    })
    .optional(),
  organization: accountSchema.optional(),
  repository: z
    .object({
      id: githubIdSchema.optional(),
      full_name: z.string().min(1).optional(),
      owner: accountSchema.optional(),
    })
    .optional(),
  pull_request: z.object({ number: githubIdSchema.optional() }).optional(),
});

type Account = z.infer<typeof accountSchema>;

/**
 * The row's worth of facts, and the exact set of them. Everything nullable here
 * is nullable in the ledger for the same reason: a lifecycle delivery carries
 * only the bounded ids the removal needs and has no one repository to locate.
 */
export interface IngressEnvelope {
  /** `X-GitHub-Delivery`. Reused on a manual redelivery, so never a key. */
  readonly deliveryGuid: string;
  /** `X-GitHub-Event`. */
  readonly event: string;
  readonly action: string | null;
  /** GitHub's durable numeric Owner id, which is the tenant key itself. */
  readonly ownerId: number;
  readonly ownerLogin: string;
  readonly ownerType: OwnerType;
  readonly installationId: number | null;
  readonly repositoryId: number | null;
  /** The `owner/name` locator **as the delivery carried it**. */
  readonly repositoryNameWithOwner: string | null;
  readonly pullRequestNumber: number | null;
}

/** An envelope, or the reason these bytes could not become one. */
export type NormalizedDelivery =
  | { readonly kind: "envelope"; readonly envelope: IngressEnvelope }
  | { readonly kind: "malformed"; readonly reason: string };

/** A signature-verified delivery, still unparsed. */
export interface ReceivedDelivery {
  readonly event: string;
  readonly deliveryGuid: string;
  /** The exact bytes, which the signature has already been checked against. */
  readonly body: Uint8Array;
}

const malformed = (reason: string): NormalizedDelivery => ({
  kind: "malformed",
  reason,
});

const ownerOf = (
  account: Account
): Pick<IngressEnvelope, "ownerId" | "ownerLogin" | "ownerType"> => ({
  ownerId: account.id,
  ownerLogin: account.login ?? String(account.id),
  ownerType: account.type?.toLowerCase() === "user" ? "user" : "organization",
});

/**
 * Where an Owner locator is, in the order ADR 0008's entry-point table names
 * them. A `pull_request` delivery carries `repository.owner`; a lifecycle
 * delivery carries the installation's account instead, and `organization` is
 * the last resort for an event that names neither.
 */
const locateOwner = (
  payload: z.infer<typeof payloadSchema>
): Account | undefined =>
  payload.repository?.owner ??
  payload.installation?.account ??
  payload.organization;

/**
 * Reads a verified delivery into the envelope the ledger commits.
 *
 * @param delivery The event, the delivery GUID and the verified bytes.
 * @returns The envelope, or the reason there is none.
 */
export const normalizeDelivery = (
  delivery: ReceivedDelivery
): NormalizedDelivery => {
  if (delivery.event === "") {
    return malformed("the delivery carried no event name");
  }
  if (delivery.deliveryGuid === "") {
    return malformed("the delivery carried no GUID");
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(delivery.body));
  } catch (error) {
    return malformed(
      `the delivery body is not JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return malformed(
      `the delivery body is not a GitHub payload: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`
    );
  }

  const account = locateOwner(parsed.data);
  if (!account) {
    return malformed(
      "the delivery carries no Owner locator, and GitHub's numeric Owner id is the tenant key every query needs"
    );
  }

  const { repository, pull_request: pullRequest } = parsed.data;

  return {
    kind: "envelope",
    envelope: {
      deliveryGuid: delivery.deliveryGuid,
      event: delivery.event,
      action: parsed.data.action ?? null,
      ...ownerOf(account),
      installationId: parsed.data.installation?.id ?? null,
      // Only where the delivery names exactly one repository.
      // `installation_repositories` names a list, and picking the first would
      // record a locator the delivery did not make.
      repositoryId: repository?.id ?? null,
      repositoryNameWithOwner: repository?.full_name ?? null,
      pullRequestNumber: pullRequest?.number ?? parsed.data.number ?? null,
    },
  };
};
