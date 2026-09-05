/**
 * The authoring-time check, measured the only way it can be: against
 * classifications that are deliberately wrong.
 *
 * Asserting that the real schema passes proves the repository holds today. It
 * does not prove the check would refuse anything, and the failures
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)
 * exists for - an unclassified table, a second permissive policy beside a
 * correct one, a hand-rolled predicate carrying ADR 0008's bare cast - have no
 * representation in a schema that is correct. So each of them is built here as a
 * fixture table and handed to the check as its own classification.
 */
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { bigint, pgPolicy, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { Classification } from "./classification.js";
import { checkDeclaredTenancy } from "./declared.js";
import { RUNTIME_ROLE } from "./roles.js";
import * as schema from "./schema.js";
import { ownerContext, runtimeRole, tenantPolicy } from "./schema.js";

/** A correctly declared Owner-scoped table, and the shape each fixture bends. */
const wellFormed = pgTable(
  "fixture",
  {
    id: text("id").primaryKey(),
    ownerId: bigint("owner_id", { mode: "number" }).notNull(),
  },
  (t) => [tenantPolicy("fixture_tenant", t.ownerId)]
);

/** The same, carrying a second permissive policy beside the correct one. */
const secondPolicy = pgTable(
  "fixture",
  {
    id: text("id").primaryKey(),
    ownerId: bigint("owner_id", { mode: "number" }).notNull(),
  },
  (t) => [
    tenantPolicy("fixture_tenant", t.ownerId),
    pgPolicy("fixture_admin", {
      for: "all",
      to: runtimeRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ]
);

/**
 * ADR 0008's outage wearing a disguise: the bare `::bigint` cast, which is
 * correct on every direct connection and raises from inside the policy behind a
 * pooler that reset the GUC to the empty string.
 */
const bareCast = pgTable(
  "fixture",
  {
    id: text("id").primaryKey(),
    ownerId: bigint("owner_id", { mode: "number" }).notNull(),
  },
  (t) => [
    pgPolicy("fixture_tenant", {
      for: "all",
      to: runtimeRole,
      using: sql`${t.ownerId} = current_setting('app.owner_id', true)::bigint`,
      withCheck: sql`${t.ownerId} = current_setting('app.owner_id', true)::bigint`,
    }),
  ]
);

/** A policy granted to `public` rather than to the restricted runtime role. */
const wrongRole = pgTable(
  "fixture",
  {
    id: text("id").primaryKey(),
    ownerId: bigint("owner_id", { mode: "number" }).notNull(),
  },
  (t) => [
    pgPolicy("fixture_tenant", {
      for: "all",
      to: "public",
      using: sql`${t.ownerId} = ${ownerContext}`,
      withCheck: sql`${t.ownerId} = ${ownerContext}`,
    }),
  ]
);

/** A non-tenant table that declares a policy anyway. */
const policiedNonTenant = pgTable(
  "fixture_auth",
  { id: text("id").primaryKey() },
  (t) => [
    pgPolicy("fixture_auth_open", {
      for: "all",
      to: runtimeRole,
      using: sql`${t.id} is not null`,
      withCheck: sql`${t.id} is not null`,
    }),
  ]
);

/** A classification over the fixtures alone, so nothing else can fail it. */
const only = (
  tenant: readonly PgTable[],
  nonTenant: readonly PgTable[] = [],
  managed: readonly PgTable[] = [...tenant, ...nonTenant]
): Classification => ({ managed, tenant, nonTenant });

describe(checkDeclaredTenancy, () => {
  it("passes on the committed classification", () => {
    expect(checkDeclaredTenancy()).toStrictEqual([]);
  });

  it("passes on a well-formed fixture, so the rejections below mean something", () => {
    expect(checkDeclaredTenancy(only([wellFormed]))).toStrictEqual([]);
  });

  it("fails a managed table that is classified as neither", () => {
    const problems = checkDeclaredTenancy(
      only([], [], [wellFormed, policiedNonTenant])
    );

    expect(problems.join("; ")).toContain(
      "managed but classified as neither tenant nor non-tenant: fixture"
    );
  });

  it("fails a table classified as both", () => {
    const problems = checkDeclaredTenancy({
      managed: [wellFormed],
      tenant: [wellFormed],
      nonTenant: [wellFormed],
    });

    expect(problems.join("; ")).toContain("classified as both: fixture");
  });

  it("fails a classified table the schema module does not manage", () => {
    const problems = checkDeclaredTenancy({
      managed: [],
      tenant: [wellFormed],
      nonTenant: [],
    });

    expect(problems.join("; ")).toContain(
      "classified but not managed by the schema module: fixture"
    );
  });

  it("fails a second permissive policy sitting beside a correct one", () => {
    // Postgres combines permissive policies by OR, so this is a full tenant
    // bypass that every presence check passes.
    const problems = checkDeclaredTenancy(only([secondPolicy]));

    expect(problems.join("; ")).toContain("fixture declares 2 policies");
  });

  it("fails a hand-rolled predicate carrying the bare cast", () => {
    // The comparison is against what the pinned dialect renders for
    // `tenantPolicy()`, which is what catches this without freezing the
    // predicate's spelling into an assertion.
    const problems = checkDeclaredTenancy(only([bareCast]));

    expect(problems.join("; ")).toContain(
      "where the canonical tenant policy is"
    );
    expect(problems.join("; ")).toContain("nullif");
  });

  it("fails a tenant policy granted to a role other than the runtime role", () => {
    const problems = checkDeclaredTenancy(only([wrongRole]));

    expect(problems.join("; ")).toContain(
      `rather than to ${RUNTIME_ROLE} alone`
    );
  });

  it("fails a tenant table declaring no policy at all", () => {
    const problems = checkDeclaredTenancy(only([schema.user]));

    expect(problems.join("; ")).toContain("user declares 0 policies");
  });

  it("fails a non-tenant table that declares any policy", () => {
    const problems = checkDeclaredTenancy(only([], [policiedNonTenant]));

    expect(problems.join("; ")).toContain(
      "fixture_auth is non-tenant and must declare no policy, but declares fixture_auth_open"
    );
  });
});
