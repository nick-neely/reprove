/**
 * The bounded normalized envelope [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * commits before it acknowledges anything.
 *
 * Two properties are the subject. It carries **only durable locator and trigger
 * facts**, because persisting the raw body would durably duplicate pull request
 * narrative and other repository-derived content for facts that are re-fetched
 * anyway. And it carries an Owner locator, because ADR 0008 makes GitHub's
 * numeric Owner id the tenant key and there is no query to run without one.
 */
import { describe, expect, it } from "vitest";

import type { IngressEnvelope } from "./envelope.js";
import { normalizeDelivery } from "./envelope.js";

const bytes = <Fixture>(value: Fixture): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const GUID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

const PULL_REQUEST = {
  action: "opened",
  number: 7,
  installation: { id: 42 },
  repository: {
    id: 3001,
    full_name: "acme/reprove",
    owner: { id: 1001, login: "acme", type: "Organization" },
  },
  pull_request: {
    number: 7,
    head: { sha: "b".repeat(40) },
    body: "a pull request description nobody should be able to find in the ledger",
  },
};

const normalized = <Fixture>(
  event: string,
  payload: Fixture,
  deliveryGuid = GUID
): IngressEnvelope => {
  const outcome = normalizeDelivery({
    event,
    deliveryGuid,
    body: bytes(payload),
  });
  if (outcome.kind !== "envelope") {
    throw new Error(
      `expected an envelope, got ${outcome.kind}: ${outcome.reason}`
    );
  }
  return outcome.envelope;
};

describe("normalizing a pull_request delivery", () => {
  it("carries every locator and trigger fact the ledger records", () => {
    expect(normalized("pull_request", PULL_REQUEST)).toStrictEqual({
      deliveryGuid: GUID,
      event: "pull_request",
      action: "opened",
      ownerId: 1001,
      ownerLogin: "acme",
      ownerType: "organization",
      installationId: 42,
      repositoryId: 3001,
      repositoryNameWithOwner: "acme/reprove",
      pullRequestNumber: 7,
    });
  });

  it("carries nothing repository-derived beyond the locator", () => {
    // `toStrictEqual` above already fixes the shape; this states the reason,
    // so a field added later that happens to quote source fails here with the
    // rule beside it rather than only on a shape assertion.
    const envelope = normalized("pull_request", PULL_REQUEST);

    expect(JSON.stringify(envelope)).not.toContain(
      "a pull request description"
    );
    expect(JSON.stringify(envelope)).not.toContain("b".repeat(40));
  });

  it("normalizes GitHub's Owner type to the two values the schema holds", () => {
    const user = {
      ...PULL_REQUEST,
      repository: {
        ...PULL_REQUEST.repository,
        owner: { id: 9, login: "octocat", type: "User" },
      },
    };

    expect(normalized("pull_request", user).ownerType).toBe("user");
  });
});

describe("normalizing a lifecycle delivery", () => {
  // GitHub delivers these to every App and they cannot be unsubscribed from, so
  // the envelope has to be readable from one rather than assuming they never
  // arrive.
  it("locates the Owner through the installation account", () => {
    const removed = {
      action: "deleted",
      installation: {
        id: 42,
        account: { id: 1001, login: "acme", type: "Organization" },
      },
    };

    expect(normalized("installation", removed)).toStrictEqual({
      deliveryGuid: GUID,
      event: "installation",
      action: "deleted",
      ownerId: 1001,
      ownerLogin: "acme",
      ownerType: "organization",
      installationId: 42,
      repositoryId: null,
      repositoryNameWithOwner: null,
      pullRequestNumber: null,
    });
  });

  it("names no one repository when the removal names several", () => {
    const removed = {
      action: "removed",
      installation: {
        id: 42,
        account: { id: 1001, login: "acme", type: "Organization" },
      },
      repositories_removed: [
        { id: 3001, full_name: "acme/reprove" },
        { id: 3002, full_name: "acme/other" },
      ],
    };

    const envelope = normalized("installation_repositories", removed);
    expect(envelope.repositoryId).toBeNull();
    expect(envelope.repositoryNameWithOwner).toBeNull();
  });

  it("carries no action where the event has none", () => {
    const authorization = {
      installation: {
        id: 42,
        account: { id: 1001, login: "acme", type: "User" },
      },
    };

    expect(
      normalized("github_app_authorization", authorization).action
    ).toBeNull();
  });
});

const malformed = (event: string, body: Uint8Array, guid = GUID) =>
  normalizeDelivery({ event, deliveryGuid: guid, body });

describe("a delivery that cannot become an envelope", () => {
  it("refuses a body that is not JSON", () => {
    const outcome = malformed("pull_request", new TextEncoder().encode("{"));

    expect(outcome.kind).toBe("malformed");
  });

  it("refuses a body that is JSON but not an object", () => {
    expect(malformed("pull_request", bytes([1, 2, 3])).kind).toBe("malformed");
  });

  it("refuses a payload carrying no Owner locator", () => {
    // ADR 0008 makes GitHub's numeric Owner id the tenant key, and every query
    // runs inside `withOwner`. A delivery with no locator has nowhere to go,
    // and inventing one would be inventing a tenant.
    const outcome = malformed("pull_request", bytes({ action: "opened" }));

    expect(outcome.kind).toBe("malformed");
    expect(outcome.kind === "malformed" && outcome.reason).toContain("Owner");
  });

  it("refuses an Owner id that is not a positive safe integer", () => {
    const absurd = {
      ...PULL_REQUEST,
      repository: {
        ...PULL_REQUEST.repository,
        owner: { id: 2 ** 60, login: "acme", type: "Organization" },
      },
    };

    expect(malformed("pull_request", bytes(absurd)).kind).toBe("malformed");
  });

  it("refuses an empty event name", () => {
    expect(malformed("", bytes(PULL_REQUEST)).kind).toBe("malformed");
  });

  it("refuses an empty delivery guid", () => {
    expect(malformed("pull_request", bytes(PULL_REQUEST), "").kind).toBe(
      "malformed"
    );
  });
});
