<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/protocol

## dist/v1/index.d.ts

```ts
import { z } from "zod";
/**
 * The integer a Worker advertises for this compatibility family (ADR 0006).
 * It is independent of the package version.
 */
export declare const protocolVersion: 1;
export declare const protocolLimits: {
    readonly resultBytes: number;
    readonly summaryChars: 8000;
    readonly findings: 100;
    readonly findingBodyChars: 4000;
    readonly evidencePerFinding: 10;
    readonly evidenceExcerptChars: 2000;
    readonly anchoredTextChars: 512;
    readonly patchChars: 8000;
    readonly resolvedConfigBytes: number;
    readonly ignoreGlobs: 256;
    readonly overrides: 64;
    readonly overridePaths: 64;
    readonly egressHosts: 64;
    readonly globChars: 512;
    readonly commandChars: 2048;
};
export declare const harnessSchema: z.ZodEnum<{
    "claude-code": "claude-code";
    codex: "codex";
    opencode: "opencode";
}>;
export declare const autonomySchema: z.ZodEnum<{
    fix: "fix";
    inspect: "inspect";
    verify: "verify";
}>;
export declare const strategySchema: z.ZodEnum<{
    standard: "standard";
}>;
export declare const provenanceSchema: z.ZodEnum<{
    external: "external";
    internal: "internal";
}>;
export declare const placementSchema: z.ZodEnum<{
    hosted: "hosted";
    self_hosted: "self_hosted";
}>;
export declare const exposureSchema: z.ZodEnum<{
    account: "account";
    none: "none";
    scoped: "scoped";
}>;
export declare const severitySchema: z.ZodEnum<{
    critical: "critical";
    high: "high";
    low: "low";
    medium: "medium";
}>;
export declare const verificationSchema: z.ZodEnum<{
    inconclusive: "inconclusive";
    static: "static";
    verified: "verified";
}>;
export declare const configThresholdSchema: z.ZodObject<{
    severity: z.ZodDefault<z.ZodEnum<{
        critical: "critical";
        high: "high";
        low: "low";
        medium: "medium";
    }>>;
    verification: z.ZodDefault<z.ZodEnum<{
        any: "any";
        verified: "verified";
    }>>;
}, z.core.$strict>;
export declare const pathLocalPolicySchema: z.ZodObject<{
    threshold: z.ZodOptional<z.ZodObject<{
        severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            high: "high";
            low: "low";
            medium: "medium";
        }>>>;
        verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
            any: "any";
            verified: "verified";
        }>>>;
    }, z.core.$strict>>;
    ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const configOverrideSchema: z.ZodObject<{
    threshold: z.ZodOptional<z.ZodObject<{
        severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            high: "high";
            low: "low";
            medium: "medium";
        }>>>;
        verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
            any: "any";
            verified: "verified";
        }>>>;
    }, z.core.$strict>>;
    ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const projectCommandsSchema: z.ZodObject<{
    install: z.ZodOptional<z.ZodString>;
    build: z.ZodOptional<z.ZodString>;
    test: z.ZodOptional<z.ZodString>;
    typecheck: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const codexReasoningEffortSchema: z.ZodEnum<{
    high: "high";
    low: "low";
    max: "max";
    medium: "medium";
    xhigh: "xhigh";
}>;
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;
export declare const harnessOptionsSchema: z.ZodObject<{
    codex: z.ZodOptional<z.ZodObject<{
        reasoningEffort: z.ZodDefault<z.ZodEnum<{
            high: "high";
            low: "low";
            max: "max";
            medium: "medium";
            xhigh: "xhigh";
        }>>;
    }, z.core.$strict>>;
    claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
    openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
}, z.core.$strict>;
export declare const resolvedReviewConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    worker: z.ZodOptional<z.ZodEnum<{
        hosted: "hosted";
        "self-hosted": "self-hosted";
    }>>;
    harness: z.ZodOptional<z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
        opencode: "opencode";
    }>>;
    model: z.ZodOptional<z.ZodString>;
    strategy: z.ZodDefault<z.ZodEnum<{
        standard: "standard";
    }>>;
    autonomy: z.ZodOptional<z.ZodEnum<{
        fix: "fix";
        inspect: "inspect";
        verify: "verify";
    }>>;
    budget: z.ZodOptional<z.ZodNumber>;
    deadline: z.ZodOptional<z.ZodString>;
    event: z.ZodDefault<z.ZodEnum<{
        COMMENT: "COMMENT";
        REQUEST_CHANGES: "REQUEST_CHANGES";
    }>>;
    threshold: z.ZodDefault<z.ZodObject<{
        severity: z.ZodDefault<z.ZodEnum<{
            critical: "critical";
            high: "high";
            low: "low";
            medium: "medium";
        }>>;
        verification: z.ZodDefault<z.ZodEnum<{
            any: "any";
            verified: "verified";
        }>>;
    }, z.core.$strict>>;
    ignore: z.ZodDefault<z.ZodArray<z.ZodString>>;
    commands: z.ZodOptional<z.ZodObject<{
        install: z.ZodOptional<z.ZodString>;
        build: z.ZodOptional<z.ZodString>;
        test: z.ZodOptional<z.ZodString>;
        typecheck: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    baseConventions: z.ZodDefault<z.ZodBoolean>;
    harnessOptions: z.ZodDefault<z.ZodObject<{
        codex: z.ZodOptional<z.ZodObject<{
            reasoningEffort: z.ZodDefault<z.ZodEnum<{
                high: "high";
                low: "low";
                max: "max";
                medium: "medium";
                xhigh: "xhigh";
            }>>;
        }, z.core.$strict>>;
        claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
        openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
    }, z.core.$strict>>;
    overrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
        threshold: z.ZodOptional<z.ZodObject<{
            severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                critical: "critical";
                high: "high";
                low: "low";
                medium: "medium";
            }>>>;
            verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                any: "any";
                verified: "verified";
            }>>>;
        }, z.core.$strict>>;
        ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const resolvedSecurityConfigSchema: z.ZodObject<{
    maxExposure: z.ZodDefault<z.ZodEnum<{
        account: "account";
        none: "none";
        scoped: "scoped";
    }>>;
    allowExternalProvenance: z.ZodDefault<z.ZodBoolean>;
    installScripts: z.ZodDefault<z.ZodEnum<{
        allow: "allow";
        deny: "deny";
    }>>;
    allowHostedFallback: z.ZodDefault<z.ZodBoolean>;
    egress: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** The normalized configuration snapshot that governed this Run. */
export declare const resolvedConfigSchema: z.ZodPreprocess<z.ZodObject<{
    schemaVersion: z.ZodNumber;
    review: z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        worker: z.ZodOptional<z.ZodEnum<{
            hosted: "hosted";
            "self-hosted": "self-hosted";
        }>>;
        harness: z.ZodOptional<z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            opencode: "opencode";
        }>>;
        model: z.ZodOptional<z.ZodString>;
        strategy: z.ZodDefault<z.ZodEnum<{
            standard: "standard";
        }>>;
        autonomy: z.ZodOptional<z.ZodEnum<{
            fix: "fix";
            inspect: "inspect";
            verify: "verify";
        }>>;
        budget: z.ZodOptional<z.ZodNumber>;
        deadline: z.ZodOptional<z.ZodString>;
        event: z.ZodDefault<z.ZodEnum<{
            COMMENT: "COMMENT";
            REQUEST_CHANGES: "REQUEST_CHANGES";
        }>>;
        threshold: z.ZodDefault<z.ZodObject<{
            severity: z.ZodDefault<z.ZodEnum<{
                critical: "critical";
                high: "high";
                low: "low";
                medium: "medium";
            }>>;
            verification: z.ZodDefault<z.ZodEnum<{
                any: "any";
                verified: "verified";
            }>>;
        }, z.core.$strict>>;
        ignore: z.ZodDefault<z.ZodArray<z.ZodString>>;
        commands: z.ZodOptional<z.ZodObject<{
            install: z.ZodOptional<z.ZodString>;
            build: z.ZodOptional<z.ZodString>;
            test: z.ZodOptional<z.ZodString>;
            typecheck: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        baseConventions: z.ZodDefault<z.ZodBoolean>;
        harnessOptions: z.ZodDefault<z.ZodObject<{
            codex: z.ZodOptional<z.ZodObject<{
                reasoningEffort: z.ZodDefault<z.ZodEnum<{
                    high: "high";
                    low: "low";
                    max: "max";
                    medium: "medium";
                    xhigh: "xhigh";
                }>>;
            }, z.core.$strict>>;
            claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
            openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
        }, z.core.$strict>>;
        overrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
            threshold: z.ZodOptional<z.ZodObject<{
                severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                    critical: "critical";
                    high: "high";
                    low: "low";
                    medium: "medium";
                }>>>;
                verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                    any: "any";
                    verified: "verified";
                }>>>;
            }, z.core.$strict>>;
            ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
            paths: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    security: z.ZodObject<{
        maxExposure: z.ZodDefault<z.ZodEnum<{
            account: "account";
            none: "none";
            scoped: "scoped";
        }>>;
        allowExternalProvenance: z.ZodDefault<z.ZodBoolean>;
        installScripts: z.ZodDefault<z.ZodEnum<{
            allow: "allow";
            deny: "deny";
        }>>;
        allowHostedFallback: z.ZodDefault<z.ZodBoolean>;
        egress: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
}, z.core.$strict>, unknown>;
export declare const evidenceSchema: z.ZodObject<{
    command: z.ZodString;
    exitCode: z.ZodNullable<z.ZodNumber>;
    durationMs: z.ZodNumber;
    excerpt: z.ZodString;
    truncated: z.ZodBoolean;
    originalByteLength: z.ZodNumber;
}, z.core.$strip>;
export declare const locationSchema: z.ZodObject<{
    path: z.ZodString;
    startLine: z.ZodNumber;
    endLine: z.ZodNumber;
}, z.core.$strip>;
export declare const patchSchema: z.ZodObject<{
    path: z.ZodString;
    startLine: z.ZodNumber;
    endLine: z.ZodNumber;
    replacement: z.ZodString;
}, z.core.$strip>;
export declare const findingSchema: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodString;
    severity: z.ZodEnum<{
        critical: "critical";
        high: "high";
        low: "low";
        medium: "medium";
    }>;
    verification: z.ZodEnum<{
        inconclusive: "inconclusive";
        static: "static";
        verified: "verified";
    }>;
    location: z.ZodObject<{
        path: z.ZodString;
        startLine: z.ZodNumber;
        endLine: z.ZodNumber;
    }, z.core.$strip>;
    anchoredText: z.ZodString;
    evidence: z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        exitCode: z.ZodNullable<z.ZodNumber>;
        durationMs: z.ZodNumber;
        excerpt: z.ZodString;
        truncated: z.ZodBoolean;
        originalByteLength: z.ZodNumber;
    }, z.core.$strip>>;
    patch: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        startLine: z.ZodNumber;
        endLine: z.ZodNumber;
        replacement: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const usageSchema: z.ZodObject<{
    inputTokens: z.ZodNumber;
    outputTokens: z.ZodNumber;
    cachedInputTokens: z.ZodOptional<z.ZodNumber>;
    reasoningTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const passRecordSchema: z.ZodObject<{
    passId: z.ZodString;
    harness: z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
        opencode: "opencode";
    }>;
    pinnedModel: z.ZodString;
    resolvedModel: z.ZodNullable<z.ZodString>;
    startedAt: z.ZodString;
    endedAt: z.ZodString;
    outcome: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
    }>;
    failureReason: z.ZodNullable<z.ZodString>;
    repairTurnUsed: z.ZodBoolean;
    usage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cachedInputTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;
/**
 * One atomic Result payload. The preprocessing check counts unknown additive
 * fields too, before Zod intentionally strips them for forward compatibility.
 */
export declare const resultSchema: z.ZodPreprocess<z.ZodObject<{
    runId: z.ZodString;
    completeness: z.ZodEnum<{
        complete: "complete";
        partial: "partial";
    }>;
    stoppedBy: z.ZodNullable<z.ZodEnum<{
        budget_exhausted: "budget_exhausted";
        cancelled: "cancelled";
        superseded: "superseded";
    }>>;
    summary: z.ZodString;
    disprovedHypothesisCount: z.ZodNumber;
    findings: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        body: z.ZodString;
        severity: z.ZodEnum<{
            critical: "critical";
            high: "high";
            low: "low";
            medium: "medium";
        }>;
        verification: z.ZodEnum<{
            inconclusive: "inconclusive";
            static: "static";
            verified: "verified";
        }>;
        location: z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
        }, z.core.$strip>;
        anchoredText: z.ZodString;
        evidence: z.ZodArray<z.ZodObject<{
            command: z.ZodString;
            exitCode: z.ZodNullable<z.ZodNumber>;
            durationMs: z.ZodNumber;
            excerpt: z.ZodString;
            truncated: z.ZodBoolean;
            originalByteLength: z.ZodNumber;
        }, z.core.$strip>>;
        patch: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            startLine: z.ZodNumber;
            endLine: z.ZodNumber;
            replacement: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    passes: z.ZodArray<z.ZodObject<{
        passId: z.ZodString;
        harness: z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            opencode: "opencode";
        }>;
        pinnedModel: z.ZodString;
        resolvedModel: z.ZodNullable<z.ZodString>;
        startedAt: z.ZodString;
        endedAt: z.ZodString;
        outcome: z.ZodEnum<{
            completed: "completed";
            failed: "failed";
        }>;
        failureReason: z.ZodNullable<z.ZodString>;
        repairTurnUsed: z.ZodBoolean;
        usage: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cachedInputTokens: z.ZodOptional<z.ZodNumber>;
            reasoningTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    usage: z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        cachedInputTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    protocolVersion: z.ZodLiteral<1>;
    workerBuildVersion: z.ZodString;
}, z.core.$strip>, unknown>;
/** Fixed when the control plane creates a Run and sent unchanged to a Worker. */
export declare const runSpecSchema: z.ZodObject<{
    runId: z.ZodString;
    ownerId: z.ZodString;
    repositoryId: z.ZodString;
    installationId: z.ZodString;
    pullRequestNumber: z.ZodNumber;
    baseSha: z.ZodString;
    headSha: z.ZodString;
    provenance: z.ZodEnum<{
        external: "external";
        internal: "internal";
    }>;
    provenanceBasis: z.ZodObject<{
        ruleVersion: z.ZodNumber;
        baseRepositoryId: z.ZodNumber;
        headRepositoryId: z.ZodNullable<z.ZodNumber>;
        authorAssociation: z.ZodString;
        authorId: z.ZodNumber;
        matchedSameRepository: z.ZodBoolean;
        matchedAssociation: z.ZodBoolean;
    }, z.core.$strip>;
    trigger: z.ZodEnum<{
        automatic: "automatic";
        manual: "manual";
    }>;
    placement: z.ZodEnum<{
        hosted: "hosted";
        self_hosted: "self_hosted";
    }>;
    allowHostedFallback: z.ZodBoolean;
    harness: z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
        opencode: "opencode";
    }>;
    model: z.ZodString;
    strategy: z.ZodEnum<{
        standard: "standard";
    }>;
    autonomy: z.ZodEnum<{
        fix: "fix";
        inspect: "inspect";
        verify: "verify";
    }>;
    resolvedConfig: z.ZodPreprocess<z.ZodObject<{
        schemaVersion: z.ZodNumber;
        review: z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            worker: z.ZodOptional<z.ZodEnum<{
                hosted: "hosted";
                "self-hosted": "self-hosted";
            }>>;
            harness: z.ZodOptional<z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
                opencode: "opencode";
            }>>;
            model: z.ZodOptional<z.ZodString>;
            strategy: z.ZodDefault<z.ZodEnum<{
                standard: "standard";
            }>>;
            autonomy: z.ZodOptional<z.ZodEnum<{
                fix: "fix";
                inspect: "inspect";
                verify: "verify";
            }>>;
            budget: z.ZodOptional<z.ZodNumber>;
            deadline: z.ZodOptional<z.ZodString>;
            event: z.ZodDefault<z.ZodEnum<{
                COMMENT: "COMMENT";
                REQUEST_CHANGES: "REQUEST_CHANGES";
            }>>;
            threshold: z.ZodDefault<z.ZodObject<{
                severity: z.ZodDefault<z.ZodEnum<{
                    critical: "critical";
                    high: "high";
                    low: "low";
                    medium: "medium";
                }>>;
                verification: z.ZodDefault<z.ZodEnum<{
                    any: "any";
                    verified: "verified";
                }>>;
            }, z.core.$strict>>;
            ignore: z.ZodDefault<z.ZodArray<z.ZodString>>;
            commands: z.ZodOptional<z.ZodObject<{
                install: z.ZodOptional<z.ZodString>;
                build: z.ZodOptional<z.ZodString>;
                test: z.ZodOptional<z.ZodString>;
                typecheck: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            baseConventions: z.ZodDefault<z.ZodBoolean>;
            harnessOptions: z.ZodDefault<z.ZodObject<{
                codex: z.ZodOptional<z.ZodObject<{
                    reasoningEffort: z.ZodDefault<z.ZodEnum<{
                        high: "high";
                        low: "low";
                        max: "max";
                        medium: "medium";
                        xhigh: "xhigh";
                    }>>;
                }, z.core.$strict>>;
                claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
            }, z.core.$strict>>;
            overrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
                threshold: z.ZodOptional<z.ZodObject<{
                    severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                        critical: "critical";
                        high: "high";
                        low: "low";
                        medium: "medium";
                    }>>>;
                    verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                        any: "any";
                        verified: "verified";
                    }>>>;
                }, z.core.$strict>>;
                ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
                paths: z.ZodArray<z.ZodString>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        security: z.ZodObject<{
            maxExposure: z.ZodDefault<z.ZodEnum<{
                account: "account";
                none: "none";
                scoped: "scoped";
            }>>;
            allowExternalProvenance: z.ZodDefault<z.ZodBoolean>;
            installScripts: z.ZodDefault<z.ZodEnum<{
                allow: "allow";
                deny: "deny";
            }>>;
            allowHostedFallback: z.ZodDefault<z.ZodBoolean>;
            egress: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
    }, z.core.$strict>, unknown>;
    configDigest: z.ZodString;
    claimableUntil: z.ZodString;
    createdAt: z.ZodString;
}, z.core.$strip>;
/**
 * What a Worker offers when it asks for work, and it is deliberately **not** a
 * `z.literal(protocolVersion)`.
 *
 * ADR 0006 requires a Worker below `minimum` to receive a structured
 * `upgrade_required` naming the minimum rather than to be told its request was
 * malformed. A literal here would make an incompatible Worker's honest
 * statement of its own version a schema failure, so the one message that has to
 * carry a foreign version is the one message whose version is a plain integer.
 *
 * `runId` is optional because the same request is both a poll and a targeted
 * claim: absent, the control plane picks the oldest claimable Run for this
 * Owner; present, it claims exactly that one or names why it could not.
 */
export declare const claimRequestSchema: z.ZodObject<{
    protocolVersion: z.ZodNumber;
    workerBuildVersion: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * What a granted claim returns: the Run to execute, and the execution ownership
 * created by the claim itself
 * ([ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)).
 *
 * `executionToken` identifies the execution authorized to submit against the
 * Run and `executionExpiresAt` is the control-plane liveness boundary for it.
 * Both are on the grant rather than on the `RunSpec`, because the spec is fixed
 * at Run creation and these two are written at claim - a Run that is claimed
 * twice has the same spec and a different execution.
 */
export declare const claimGrantSchema: z.ZodObject<{
    runSpec: z.ZodObject<{
        runId: z.ZodString;
        ownerId: z.ZodString;
        repositoryId: z.ZodString;
        installationId: z.ZodString;
        pullRequestNumber: z.ZodNumber;
        baseSha: z.ZodString;
        headSha: z.ZodString;
        provenance: z.ZodEnum<{
            external: "external";
            internal: "internal";
        }>;
        provenanceBasis: z.ZodObject<{
            ruleVersion: z.ZodNumber;
            baseRepositoryId: z.ZodNumber;
            headRepositoryId: z.ZodNullable<z.ZodNumber>;
            authorAssociation: z.ZodString;
            authorId: z.ZodNumber;
            matchedSameRepository: z.ZodBoolean;
            matchedAssociation: z.ZodBoolean;
        }, z.core.$strip>;
        trigger: z.ZodEnum<{
            automatic: "automatic";
            manual: "manual";
        }>;
        placement: z.ZodEnum<{
            hosted: "hosted";
            self_hosted: "self_hosted";
        }>;
        allowHostedFallback: z.ZodBoolean;
        harness: z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            opencode: "opencode";
        }>;
        model: z.ZodString;
        strategy: z.ZodEnum<{
            standard: "standard";
        }>;
        autonomy: z.ZodEnum<{
            fix: "fix";
            inspect: "inspect";
            verify: "verify";
        }>;
        resolvedConfig: z.ZodPreprocess<z.ZodObject<{
            schemaVersion: z.ZodNumber;
            review: z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                worker: z.ZodOptional<z.ZodEnum<{
                    hosted: "hosted";
                    "self-hosted": "self-hosted";
                }>>;
                harness: z.ZodOptional<z.ZodEnum<{
                    "claude-code": "claude-code";
                    codex: "codex";
                    opencode: "opencode";
                }>>;
                model: z.ZodOptional<z.ZodString>;
                strategy: z.ZodDefault<z.ZodEnum<{
                    standard: "standard";
                }>>;
                autonomy: z.ZodOptional<z.ZodEnum<{
                    fix: "fix";
                    inspect: "inspect";
                    verify: "verify";
                }>>;
                budget: z.ZodOptional<z.ZodNumber>;
                deadline: z.ZodOptional<z.ZodString>;
                event: z.ZodDefault<z.ZodEnum<{
                    COMMENT: "COMMENT";
                    REQUEST_CHANGES: "REQUEST_CHANGES";
                }>>;
                threshold: z.ZodDefault<z.ZodObject<{
                    severity: z.ZodDefault<z.ZodEnum<{
                        critical: "critical";
                        high: "high";
                        low: "low";
                        medium: "medium";
                    }>>;
                    verification: z.ZodDefault<z.ZodEnum<{
                        any: "any";
                        verified: "verified";
                    }>>;
                }, z.core.$strict>>;
                ignore: z.ZodDefault<z.ZodArray<z.ZodString>>;
                commands: z.ZodOptional<z.ZodObject<{
                    install: z.ZodOptional<z.ZodString>;
                    build: z.ZodOptional<z.ZodString>;
                    test: z.ZodOptional<z.ZodString>;
                    typecheck: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                baseConventions: z.ZodDefault<z.ZodBoolean>;
                harnessOptions: z.ZodDefault<z.ZodObject<{
                    codex: z.ZodOptional<z.ZodObject<{
                        reasoningEffort: z.ZodDefault<z.ZodEnum<{
                            high: "high";
                            low: "low";
                            max: "max";
                            medium: "medium";
                            xhigh: "xhigh";
                        }>>;
                    }, z.core.$strict>>;
                    claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                    openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                }, z.core.$strict>>;
                overrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
                    threshold: z.ZodOptional<z.ZodObject<{
                        severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                            critical: "critical";
                            high: "high";
                            low: "low";
                            medium: "medium";
                        }>>>;
                        verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                            any: "any";
                            verified: "verified";
                        }>>>;
                    }, z.core.$strict>>;
                    ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    paths: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>>;
            }, z.core.$strict>;
            security: z.ZodObject<{
                maxExposure: z.ZodDefault<z.ZodEnum<{
                    account: "account";
                    none: "none";
                    scoped: "scoped";
                }>>;
                allowExternalProvenance: z.ZodDefault<z.ZodBoolean>;
                installScripts: z.ZodDefault<z.ZodEnum<{
                    allow: "allow";
                    deny: "deny";
                }>>;
                allowHostedFallback: z.ZodDefault<z.ZodBoolean>;
                egress: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>;
        }, z.core.$strict>, unknown>;
        configDigest: z.ZodString;
        claimableUntil: z.ZodString;
        createdAt: z.ZodString;
    }, z.core.$strip>;
    executionToken: z.ZodString;
    executionExpiresAt: z.ZodString;
    protocolVersion: z.ZodLiteral<1>;
}, z.core.$strip>;
/**
 * The claim exchange, as one named pair.
 *
 * It sits beside {@link protocolSchemas} rather than inside it: that constant is
 * "the complete set of protocol v1 payload schemas crossing the Worker seam" in
 * the direction of a Run's *content*, and a compatibility test asserts its three
 * keys exactly. The claim is the scheduling half, which ADR 0006 says a hosted
 * Worker never exercises at all.
 */
export declare const claimSchemas: {
    readonly request: z.ZodObject<{
        protocolVersion: z.ZodNumber;
        workerBuildVersion: z.ZodString;
        runId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    readonly grant: z.ZodObject<{
        runSpec: z.ZodObject<{
            runId: z.ZodString;
            ownerId: z.ZodString;
            repositoryId: z.ZodString;
            installationId: z.ZodString;
            pullRequestNumber: z.ZodNumber;
            baseSha: z.ZodString;
            headSha: z.ZodString;
            provenance: z.ZodEnum<{
                external: "external";
                internal: "internal";
            }>;
            provenanceBasis: z.ZodObject<{
                ruleVersion: z.ZodNumber;
                baseRepositoryId: z.ZodNumber;
                headRepositoryId: z.ZodNullable<z.ZodNumber>;
                authorAssociation: z.ZodString;
                authorId: z.ZodNumber;
                matchedSameRepository: z.ZodBoolean;
                matchedAssociation: z.ZodBoolean;
            }, z.core.$strip>;
            trigger: z.ZodEnum<{
                automatic: "automatic";
                manual: "manual";
            }>;
            placement: z.ZodEnum<{
                hosted: "hosted";
                self_hosted: "self_hosted";
            }>;
            allowHostedFallback: z.ZodBoolean;
            harness: z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
                opencode: "opencode";
            }>;
            model: z.ZodString;
            strategy: z.ZodEnum<{
                standard: "standard";
            }>;
            autonomy: z.ZodEnum<{
                fix: "fix";
                inspect: "inspect";
                verify: "verify";
            }>;
            resolvedConfig: z.ZodPreprocess<z.ZodObject<{
                schemaVersion: z.ZodNumber;
                review: z.ZodObject<{
                    enabled: z.ZodDefault<z.ZodBoolean>;
                    worker: z.ZodOptional<z.ZodEnum<{
                        hosted: "hosted";
                        "self-hosted": "self-hosted";
                    }>>;
                    harness: z.ZodOptional<z.ZodEnum<{
                        "claude-code": "claude-code";
                        codex: "codex";
                        opencode: "opencode";
                    }>>;
                    model: z.ZodOptional<z.ZodString>;
                    strategy: z.ZodDefault<z.ZodEnum<{
                        standard: "standard";
                    }>>;
                    autonomy: z.ZodOptional<z.ZodEnum<{
                        fix: "fix";
                        inspect: "inspect";
                        verify: "verify";
                    }>>;
                    budget: z.ZodOptional<z.ZodNumber>;
                    deadline: z.ZodOptional<z.ZodString>;
                    event: z.ZodDefault<z.ZodEnum<{
                        COMMENT: "COMMENT";
                        REQUEST_CHANGES: "REQUEST_CHANGES";
                    }>>;
                    threshold: z.ZodDefault<z.ZodObject<{
                        severity: z.ZodDefault<z.ZodEnum<{
                            critical: "critical";
                            high: "high";
                            low: "low";
                            medium: "medium";
                        }>>;
                        verification: z.ZodDefault<z.ZodEnum<{
                            any: "any";
                            verified: "verified";
                        }>>;
                    }, z.core.$strict>>;
                    ignore: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    commands: z.ZodOptional<z.ZodObject<{
                        install: z.ZodOptional<z.ZodString>;
                        build: z.ZodOptional<z.ZodString>;
                        test: z.ZodOptional<z.ZodString>;
                        typecheck: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    baseConventions: z.ZodDefault<z.ZodBoolean>;
                    harnessOptions: z.ZodDefault<z.ZodObject<{
                        codex: z.ZodOptional<z.ZodObject<{
                            reasoningEffort: z.ZodDefault<z.ZodEnum<{
                                high: "high";
                                low: "low";
                                max: "max";
                                medium: "medium";
                                xhigh: "xhigh";
                            }>>;
                        }, z.core.$strict>>;
                        claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                        openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                    }, z.core.$strict>>;
                    overrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
                        threshold: z.ZodOptional<z.ZodObject<{
                            severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                                critical: "critical";
                                high: "high";
                                low: "low";
                                medium: "medium";
                            }>>>;
                            verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                                any: "any";
                                verified: "verified";
                            }>>>;
                        }, z.core.$strict>>;
                        ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        paths: z.ZodArray<z.ZodString>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>;
                security: z.ZodObject<{
                    maxExposure: z.ZodDefault<z.ZodEnum<{
                        account: "account";
                        none: "none";
                        scoped: "scoped";
                    }>>;
                    allowExternalProvenance: z.ZodDefault<z.ZodBoolean>;
                    installScripts: z.ZodDefault<z.ZodEnum<{
                        allow: "allow";
                        deny: "deny";
                    }>>;
                    allowHostedFallback: z.ZodDefault<z.ZodBoolean>;
                    egress: z.ZodDefault<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>;
            }, z.core.$strict>, unknown>;
            configDigest: z.ZodString;
            claimableUntil: z.ZodString;
            createdAt: z.ZodString;
        }, z.core.$strip>;
        executionToken: z.ZodString;
        executionExpiresAt: z.ZodString;
        protocolVersion: z.ZodLiteral<1>;
    }, z.core.$strip>;
};
/** A Worker's pre-execution decision that it cannot serve the offered Run. */
export declare const refusalSchema: z.ZodObject<{
    runId: z.ZodString;
    reason: z.ZodString;
    required: z.ZodNullable<z.ZodString>;
    actual: z.ZodNullable<z.ZodString>;
    protocolVersion: z.ZodLiteral<1>;
    workerBuildVersion: z.ZodString;
}, z.core.$strip>;
/** The complete set of protocol v1 payload schemas crossing the Worker seam. */
export declare const protocolSchemas: {
    readonly runSpec: z.ZodObject<{
        runId: z.ZodString;
        ownerId: z.ZodString;
        repositoryId: z.ZodString;
        installationId: z.ZodString;
        pullRequestNumber: z.ZodNumber;
        baseSha: z.ZodString;
        headSha: z.ZodString;
        provenance: z.ZodEnum<{
            external: "external";
            internal: "internal";
        }>;
        provenanceBasis: z.ZodObject<{
            ruleVersion: z.ZodNumber;
            baseRepositoryId: z.ZodNumber;
            headRepositoryId: z.ZodNullable<z.ZodNumber>;
            authorAssociation: z.ZodString;
            authorId: z.ZodNumber;
            matchedSameRepository: z.ZodBoolean;
            matchedAssociation: z.ZodBoolean;
        }, z.core.$strip>;
        trigger: z.ZodEnum<{
            automatic: "automatic";
            manual: "manual";
        }>;
        placement: z.ZodEnum<{
            hosted: "hosted";
            self_hosted: "self_hosted";
        }>;
        allowHostedFallback: z.ZodBoolean;
        harness: z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            opencode: "opencode";
        }>;
        model: z.ZodString;
        strategy: z.ZodEnum<{
            standard: "standard";
        }>;
        autonomy: z.ZodEnum<{
            fix: "fix";
            inspect: "inspect";
            verify: "verify";
        }>;
        resolvedConfig: z.ZodPreprocess<z.ZodObject<{
            schemaVersion: z.ZodNumber;
            review: z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                worker: z.ZodOptional<z.ZodEnum<{
                    hosted: "hosted";
                    "self-hosted": "self-hosted";
                }>>;
                harness: z.ZodOptional<z.ZodEnum<{
                    "claude-code": "claude-code";
                    codex: "codex";
                    opencode: "opencode";
                }>>;
                model: z.ZodOptional<z.ZodString>;
                strategy: z.ZodDefault<z.ZodEnum<{
                    standard: "standard";
                }>>;
                autonomy: z.ZodOptional<z.ZodEnum<{
                    fix: "fix";
                    inspect: "inspect";
                    verify: "verify";
                }>>;
                budget: z.ZodOptional<z.ZodNumber>;
                deadline: z.ZodOptional<z.ZodString>;
                event: z.ZodDefault<z.ZodEnum<{
                    COMMENT: "COMMENT";
                    REQUEST_CHANGES: "REQUEST_CHANGES";
                }>>;
                threshold: z.ZodDefault<z.ZodObject<{
                    severity: z.ZodDefault<z.ZodEnum<{
                        critical: "critical";
                        high: "high";
                        low: "low";
                        medium: "medium";
                    }>>;
                    verification: z.ZodDefault<z.ZodEnum<{
                        any: "any";
                        verified: "verified";
                    }>>;
                }, z.core.$strict>>;
                ignore: z.ZodDefault<z.ZodArray<z.ZodString>>;
                commands: z.ZodOptional<z.ZodObject<{
                    install: z.ZodOptional<z.ZodString>;
                    build: z.ZodOptional<z.ZodString>;
                    test: z.ZodOptional<z.ZodString>;
                    typecheck: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                baseConventions: z.ZodDefault<z.ZodBoolean>;
                harnessOptions: z.ZodDefault<z.ZodObject<{
                    codex: z.ZodOptional<z.ZodObject<{
                        reasoningEffort: z.ZodDefault<z.ZodEnum<{
                            high: "high";
                            low: "low";
                            max: "max";
                            medium: "medium";
                            xhigh: "xhigh";
                        }>>;
                    }, z.core.$strict>>;
                    claudeCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                    openCode: z.ZodOptional<z.ZodObject<{}, z.core.$strict>>;
                }, z.core.$strict>>;
                overrides: z.ZodDefault<z.ZodArray<z.ZodObject<{
                    threshold: z.ZodOptional<z.ZodObject<{
                        severity: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                            critical: "critical";
                            high: "high";
                            low: "low";
                            medium: "medium";
                        }>>>;
                        verification: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
                            any: "any";
                            verified: "verified";
                        }>>>;
                    }, z.core.$strict>>;
                    ignore: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    paths: z.ZodArray<z.ZodString>;
                }, z.core.$strict>>>;
            }, z.core.$strict>;
            security: z.ZodObject<{
                maxExposure: z.ZodDefault<z.ZodEnum<{
                    account: "account";
                    none: "none";
                    scoped: "scoped";
                }>>;
                allowExternalProvenance: z.ZodDefault<z.ZodBoolean>;
                installScripts: z.ZodDefault<z.ZodEnum<{
                    allow: "allow";
                    deny: "deny";
                }>>;
                allowHostedFallback: z.ZodDefault<z.ZodBoolean>;
                egress: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>;
        }, z.core.$strict>, unknown>;
        configDigest: z.ZodString;
        claimableUntil: z.ZodString;
        createdAt: z.ZodString;
    }, z.core.$strip>;
    readonly result: z.ZodPreprocess<z.ZodObject<{
        runId: z.ZodString;
        completeness: z.ZodEnum<{
            complete: "complete";
            partial: "partial";
        }>;
        stoppedBy: z.ZodNullable<z.ZodEnum<{
            budget_exhausted: "budget_exhausted";
            cancelled: "cancelled";
            superseded: "superseded";
        }>>;
        summary: z.ZodString;
        disprovedHypothesisCount: z.ZodNumber;
        findings: z.ZodArray<z.ZodObject<{
            title: z.ZodString;
            body: z.ZodString;
            severity: z.ZodEnum<{
                critical: "critical";
                high: "high";
                low: "low";
                medium: "medium";
            }>;
            verification: z.ZodEnum<{
                inconclusive: "inconclusive";
                static: "static";
                verified: "verified";
            }>;
            location: z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
            }, z.core.$strip>;
            anchoredText: z.ZodString;
            evidence: z.ZodArray<z.ZodObject<{
                command: z.ZodString;
                exitCode: z.ZodNullable<z.ZodNumber>;
                durationMs: z.ZodNumber;
                excerpt: z.ZodString;
                truncated: z.ZodBoolean;
                originalByteLength: z.ZodNumber;
            }, z.core.$strip>>;
            patch: z.ZodOptional<z.ZodObject<{
                path: z.ZodString;
                startLine: z.ZodNumber;
                endLine: z.ZodNumber;
                replacement: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        passes: z.ZodArray<z.ZodObject<{
            passId: z.ZodString;
            harness: z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
                opencode: "opencode";
            }>;
            pinnedModel: z.ZodString;
            resolvedModel: z.ZodNullable<z.ZodString>;
            startedAt: z.ZodString;
            endedAt: z.ZodString;
            outcome: z.ZodEnum<{
                completed: "completed";
                failed: "failed";
            }>;
            failureReason: z.ZodNullable<z.ZodString>;
            repairTurnUsed: z.ZodBoolean;
            usage: z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cachedInputTokens: z.ZodOptional<z.ZodNumber>;
                reasoningTokens: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>;
        }, z.core.$strip>>;
        usage: z.ZodObject<{
            inputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cachedInputTokens: z.ZodOptional<z.ZodNumber>;
            reasoningTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        protocolVersion: z.ZodLiteral<1>;
        workerBuildVersion: z.ZodString;
    }, z.core.$strip>, unknown>;
    readonly refusal: z.ZodObject<{
        runId: z.ZodString;
        reason: z.ZodString;
        required: z.ZodNullable<z.ZodString>;
        actual: z.ZodNullable<z.ZodString>;
        protocolVersion: z.ZodLiteral<1>;
        workerBuildVersion: z.ZodString;
    }, z.core.$strip>;
};
export type Autonomy = z.infer<typeof autonomySchema>;
export type ClaimGrant = z.infer<typeof claimGrantSchema>;
export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Exposure = z.infer<typeof exposureSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Harness = z.infer<typeof harnessSchema>;
export type PassRecord = z.infer<typeof passRecordSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type Refusal = z.infer<typeof refusalSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type Result = z.infer<typeof resultSchema>;
export type RunSpec = z.infer<typeof runSpecSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Verification = z.infer<typeof verificationSchema>;
```
