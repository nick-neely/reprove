/**
 * ADR 0013's trigger table, as a table.
 *
 * The rows worth measuring are the negative ones. `edited` is inert because ADR
 * 0012 classifies the title and description as Author-controlled narrative, and
 * an edit that re-triggered would be a free re-roll of the review; the three
 * events GitHub delivers to every App unconditionally are inert because the
 * handler "may not assume that an unsubscribed event never arrives".
 */
import { describe, expect, it } from "vitest";

import { intentOf } from "./trigger.js";

const intentsFor = (event: string, actions: readonly string[]) =>
  actions.map((action) => intentOf(event, action));

describe("which deliveries act", () => {
  it("reviews the four actions that can produce a Run", () => {
    expect(
      intentsFor("pull_request", [
        "opened",
        "synchronize",
        "reopened",
        "ready_for_review",
      ])
    ).toStrictEqual(["review", "review", "review", "review"]);
  });

  it("cancels on the two that can only end one", () => {
    expect(
      intentsFor("pull_request", ["closed", "converted_to_draft"])
    ).toStrictEqual(["cancel", "cancel"]);
  });

  it("is inert for edited, which would otherwise be a free re-roll", () => {
    expect(intentOf("pull_request", "edited")).toBe("inert");
  });

  it("is inert for every other pull_request action", () => {
    expect(
      intentsFor("pull_request", [
        "assigned",
        "labeled",
        "review_requested",
        "auto_merge_enabled",
        "something_github_adds_later",
      ])
    ).toStrictEqual(["inert", "inert", "inert", "inert", "inert"]);
  });

  it("is inert for the three events GitHub delivers unconditionally", () => {
    expect([
      intentOf("installation", "deleted"),
      intentOf("installation_repositories", "removed"),
      intentOf("github_app_authorization", "revoked"),
    ]).toStrictEqual(["inert", "inert", "inert"]);
  });

  it("is inert for a delivery carrying no action at all", () => {
    expect(intentOf("pull_request", null)).toBe("inert");
  });
});
