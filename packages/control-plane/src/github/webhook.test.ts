/**
 * The handler itself, and the ordering [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * makes the whole decision:
 *
 * ```text
 * verify HMAC-SHA256 over the raw bytes
 *   -> normalize a bounded ingress envelope
 *   -> commit it with its processing state
 *   -> return 200
 *   -> kick asynchronous processing
 * ```
 *
 * GitHub never automatically redelivers, so a `200` returned before anything is
 * persisted is the one genuinely unrecoverable outcome in the system. Two of the
 * cases below are therefore about *when* the answer is produced rather than what
 * it says: nothing acknowledges while the commit is still in flight, and a
 * commit that fails is a non-2xx, which buys the only recovery GitHub offers -
 * the delivery is recorded as failed in the App's delivery UI and stays manually
 * redeliverable for three days.
 */
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import {
  DELIVERY_GUID,
  deliveryBytes,
  openedPullRequestBytes,
  OPENED_PULL_REQUEST,
  signedDelivery,
  WEBHOOK_SECRET,
  WEBHOOK_URL,
} from "./delivery.test-support.js";
import type { IngressEnvelope } from "./envelope.js";
import { signDelivery } from "./signature.js";
import type { CommitEnvelope, KickProcessing } from "./webhook.js";
import {
  createGitHubWebhookHandler,
  MAXIMUM_DELIVERY_BYTES,
  WEBHOOK_STATUS,
} from "./webhook.js";

/** The ledger row id a commit resolves with. */
const DELIVERY_ROW = "5f0c2c8e-0000-4000-8000-000000000000";

/** A commit port that records what it was handed and never fails. */
const recordingCommit = () =>
  vi.fn<CommitEnvelope>(() => Promise.resolve(DELIVERY_ROW));

/** The handler, over whichever commit port a case wants to observe. */
const handlerOver = (commit: CommitEnvelope, kick?: KickProcessing) =>
  createGitHubWebhookHandler({ secret: WEBHOOK_SECRET, commit, kick });

describe("a delivery that is what it claims to be", () => {
  it("acknowledges a valid signature over the exact received bytes", async () => {
    const commit = recordingCommit();

    const response = await handlerOver(commit)(signedDelivery());

    expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("commits the bounded envelope rather than anything the payload carried", async () => {
    const commit = recordingCommit();

    await handlerOver(commit)(signedDelivery());

    expect(commit.mock.calls[0]?.[0]).toStrictEqual({
      deliveryGuid: DELIVERY_GUID,
      event: "pull_request",
      action: "opened",
      ownerId: 1001,
      ownerLogin: "acme",
      ownerType: "organization",
      installationId: 42,
      repositoryId: 3001,
      repositoryNameWithOwner: "acme/reprove",
      pullRequestNumber: 7,
    } satisfies IngressEnvelope);
  });

  it("acknowledges a lifecycle event it did not subscribe to", async () => {
    // GitHub delivers `installation`, `installation_repositories` and
    // `github_app_authorization` to every App and they cannot be unsubscribed
    // from, so the handler may not assume an unsubscribed event never arrives.
    const commit = recordingCommit();

    const response = await handlerOver(commit)(
      signedDelivery({
        event: "installation",
        body: deliveryBytes({
          action: "deleted",
          installation: {
            id: 42,
            account: { id: 1001, login: "acme", type: "Organization" },
          },
        }),
      })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
    expect(commit.mock.calls[0]?.[0].event).toBe("installation");
  });
});

describe("durability before the acknowledgement", () => {
  it("has not answered while the commit is still in flight", async () => {
    // The commit takes real time, and the order it lands in relative to the
    // answer is the assertion. A handler that answered first and persisted
    // afterwards satisfies every status assertion in this file and fails here.
    const order: string[] = [];
    const handle = handlerOver(async () => {
      await delay(10);
      order.push("committed");
      return DELIVERY_ROW;
    });

    let answered = false;
    const responded = handle(signedDelivery()).then((response) => {
      answered = true;
      order.push("answered");
      return response;
    });

    await delay(0);
    expect(answered).toBeFalsy();

    const response = await responded;
    expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
    expect(order).toStrictEqual(["committed", "answered"]);
  });

  it("returns a non-2xx when the envelope cannot be committed", async () => {
    const handle = handlerOver(() =>
      Promise.reject(new Error("the database is unreachable"))
    );

    const response = await handle(signedDelivery());

    // The status is asserted through the range rather than the number,
    // because the decision ADR 0013 records is "non-2xx": that is what leaves
    // the delivery redeliverable from the App's delivery UI for three days.
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.status).toBe(WEBHOOK_STATUS.notCommitted);
  });

  it("says nothing about why the commit failed", async () => {
    const handle = handlerOver(() =>
      Promise.reject(
        new Error('relation "ingress_delivery" does not exist at 10.0.0.4:5432')
      )
    );

    const response = await handle(signedDelivery());
    const body = await response.text();

    expect(body).not.toContain("10.0.0.4");
    expect(body).not.toContain("ingress_delivery");
  });
});

describe("a delivery that is not what it claims to be", () => {
  it("rejects a tampered body under a signature that was valid for another", async () => {
    const commit = recordingCommit();
    const handle = handlerOver(commit);
    const original = openedPullRequestBytes();
    const tampered = deliveryBytes({
      ...OPENED_PULL_REQUEST,
      action: "closed",
    });

    const response = await handle(
      signedDelivery({
        body: tampered,
        signature: signDelivery(WEBHOOK_SECRET, original),
      })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.unsigned);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a delivery carrying no signature at all", async () => {
    const commit = recordingCommit();

    const response = await handlerOver(commit)(
      signedDelivery({ signature: null })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.unsigned);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a signature minted with another App's secret", async () => {
    const commit = recordingCommit();

    const response = await handlerOver(commit)(
      signedDelivery({ secret: "another-apps-webhook-secret" })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.unsigned);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with a status of its own, before hashing it", async () => {
    const commit = recordingCommit();
    const handle = createGitHubWebhookHandler({
      secret: WEBHOOK_SECRET,
      maximumBytes: 32,
      commit,
    });
    const body = openedPullRequestBytes();

    // Correctly signed, and still refused: the cap runs in front of the hash,
    // so a body over it is turned away whoever sent it.
    const response = await handle(signedDelivery({ body }));

    expect(response.status).toBe(WEBHOOK_STATUS.oversized);
    expect(response.status).not.toBe(WEBHOOK_STATUS.unsigned);
    expect(commit).not.toHaveBeenCalled();
  });

  it("caps a delivery at GitHub's own documented maximum by default", () => {
    expect(MAXIMUM_DELIVERY_BYTES).toBe(25 * 1024 * 1024);
  });
});

/** Answers with the status, and states that nothing was persisted on the way. */
const statusWithoutCommitting = async (request: Request): Promise<number> => {
  const commit = recordingCommit();

  const response = await handlerOver(commit)(request);

  expect(commit).not.toHaveBeenCalled();
  return response.status;
};

describe("a delivery that cannot become an envelope", () => {
  it("rejects a delivery with no event header", async () => {
    await expect(
      statusWithoutCommitting(signedDelivery({ without: ["x-github-event"] }))
    ).resolves.toBe(WEBHOOK_STATUS.unusable);
  });

  it("rejects a delivery with no GUID header", async () => {
    await expect(
      statusWithoutCommitting(
        signedDelivery({ without: ["x-github-delivery"] })
      )
    ).resolves.toBe(WEBHOOK_STATUS.unusable);
  });

  it("rejects a signed body that is not JSON", async () => {
    await expect(
      statusWithoutCommitting(
        signedDelivery({ body: new TextEncoder().encode("{") })
      )
    ).resolves.toBe(WEBHOOK_STATUS.unusable);
  });

  it("rejects a signed payload carrying no Owner locator", async () => {
    await expect(
      statusWithoutCommitting(
        signedDelivery({ body: deliveryBytes({ action: "opened" }) })
      )
    ).resolves.toBe(WEBHOOK_STATUS.unusable);
  });

  it("checks the signature before it reads the headers", async () => {
    // Order matters here rather than only the status: a request missing both
    // its signature and its headers is turned away as unsigned, so nothing
    // that inspects what it claims to be ever ran.
    await expect(
      statusWithoutCommitting(
        new Request(WEBHOOK_URL, {
          method: "POST",
          body: openedPullRequestBytes(),
        })
      )
    ).resolves.toBe(WEBHOOK_STATUS.unsigned);
  });
});

describe("the kick after the acknowledgement", () => {
  it("hands processing the committed row's id and the envelope it holds", async () => {
    const kick = vi.fn<KickProcessing>();

    await handlerOver(recordingCommit(), kick)(signedDelivery());

    expect(kick).toHaveBeenCalledOnce();
    expect(kick.mock.calls[0]?.[0].deliveryId).toBe(DELIVERY_ROW);
    expect(kick.mock.calls[0]?.[0].envelope.deliveryGuid).toBe(DELIVERY_GUID);
  });

  it("does not kick a delivery that was never committed", async () => {
    const kick = vi.fn<KickProcessing>();
    const handle = handlerOver(() => Promise.reject(new Error("no")), kick);

    const response = await handle(signedDelivery());

    expect(response.status).toBe(WEBHOOK_STATUS.notCommitted);
    expect(kick).not.toHaveBeenCalled();
  });

  it("still acknowledges when the kick throws on its way out", async () => {
    // Once the envelope is committed Reprove holds the intent, and the ledger
    // is what recovers it. A failed kick may not unmake the row, so it may not
    // unmake the acknowledgement either.
    const handle = handlerOver(recordingCommit(), () => {
      throw new Error("the scheduler is unreachable");
    });

    const response = await handle(signedDelivery());

    expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
  });

  it("acknowledges without waiting for what the kick started", async () => {
    const finished = vi.fn<() => void>();
    const handle = handlerOver(recordingCommit(), () => {
      setTimeout(finished, 20);
    });

    const response = await handle(signedDelivery());

    expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
    expect(finished).not.toHaveBeenCalled();
  });
});
