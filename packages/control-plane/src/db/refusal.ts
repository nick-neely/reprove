/**
 * What a failed boot assertion is, as data.
 *
 * Separated from `checks.ts` so that a caller can name the refusal without
 * reaching the Drizzle and `pg` types the checks are implemented with: ADR 0010
 * forbids `apps/control-plane` from depending on either, so neither may appear
 * on this package's published surface.
 */

/** The stable name of each of rule 6's seven checks. */
export type CheckName =
  | "runtime-role-is-not-privileged"
  | "runtime-role-owns-no-table"
  | "every-managed-table-is-classified"
  | "tenant-tables-are-forced"
  | "tenant-policies-are-exactly-canonical"
  | "migrations-match-the-committed-files"
  | "no-owner-context-reads-empty";

/** One check's verdict. `detail` is what a refusal prints. */
export interface CheckResult {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * What `createRuntimeDb()` throws instead of returning a client. There is no
 * flag that downgrades this to a warning and no path to a client that skipped
 * it: the assertion lives in the connection factory precisely so that it is
 * unskippable by construction (ADR 0010).
 *
 * `CONTEXT.md`'s noun is **Refusal**; the `Error` suffix is the JavaScript
 * convention for a throwable and is not a second domain word.
 */
export class BootRefusalError extends Error {
  readonly checks: readonly CheckResult[];

  constructor(checks: readonly CheckResult[]) {
    const failed = checks.filter((check) => !check.ok);
    super(
      [
        `refusing to serve: ${failed.length} of ${checks.length} tenancy assertions failed`,
        ...failed.map((check) => `  x ${check.name}: ${check.detail}`),
      ].join("\n")
    );
    this.name = "BootRefusalError";
    this.checks = checks;
  }
}
