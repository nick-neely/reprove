# Can a Codex Plus/Pro credential be reduced to a short-lived token before it enters the Sandbox?

Research for [#19](https://github.com/nick-neely/reprove/issues/19) (child of the foundation map
[#1](https://github.com/nick-neely/reprove/issues/1)), which
[#17](https://github.com/nick-neely/reprove/issues/17) is blocked on.
Investigated 2026-08-30.

Claims are tagged **[V]** verified (source read at a named ref, a command actually run and quoted,
or a primary-source URL with an exact quote) or **[I]** inferred (reasoning from verified facts,
labelled as such).

Sections 2-8 answer the ticket's seven numbered questions in order.

## Point-in-time versions

Everything below is pinned to these. Re-verify before relying on it after ~2026-11.

| Thing | Version | How established |
| --- | --- | --- |
| Codex CLI | **`codex-cli 0.150.0`** | `codex --version` **[V]** |
| Codex npm package | `@openai/codex@0.150.0`, native binary `@openai/codex-linux-x64` `vendor/x86_64-unknown-linux-musl/bin/codex` | `package.json` **[V]** |
| Codex source ref | tag **`rust-v0.150.0`**, commit `3b3b4f8fb3f6403e72c2d0533ed0d2f309c59717`, released 2026-08-26 | `gh api repos/openai/codex/releases/tags/rust-v0.150.0` **[V]** |
| Claude Code | **`2.1.251`** | `claude --version` **[V]** |
| OpenCode | **`1.18.25`**, source read at tag `v1.18.25` | `opencode --version` **[V]** |
| OpenAI Codex docs home | `developers.openai.com/codex/*` now 308-redirects to **`learn.chatgpt.com/docs/*`** | fetched 2026-08-30 **[V]** |

All Rust line numbers are at `rust-v0.150.0`. **[I]** The npm-distributed binary could in principle
carry patches not in that tag; `codex login --help` output matches `codex-rs/cli/src/main.rs:491-529`
byte-for-byte, which is corroboration, not proof.

**No credential was rotated, written, minted, or transmitted during this investigation.** No
`codex login`, no `codex logout`, no `claude setup-token`, no `opencode auth login`, no request to
`auth.openai.com`. Credential files were read for **structure only** - key names and JWT claim names
- and `~/.codex/auth.json`'s mtime is unchanged. The two Codex commands that were run used a
throwaway `CODEX_HOME` (see [§10.1](#101-the-safe-test-harness)).

---

## 1. Verdict

**The shape as the ticket describes it does not work, and the reason is not the one the ticket
anticipated.** Three findings, in descending order of consequence:

1. **`codex login --with-access-token` cannot accept a Plus/Pro-derived access token.** It is not a
   generic "here is a bearer token" flag. At 0.150.0 it dispatches on a literal `at-` prefix into
   exactly two credential types - a **personal access token** or an **Agent Identity JWT** - and a
   ChatGPT user access token is neither. It fails three independent checks, the first of them
   offline. **[V]** ([§2](#2-q1---does-codex-login---with-access-token-accept-a-pluspro-derived-access-token))

2. **Even if it were accepted, the token is not short-lived and not model-only.** The access token
   in `~/.codex/auth.json` on this machine carries `exp - iat = 864000s` - **ten days** - and its
   `scp` claim is `openid profile email offline_access api.connectors.read api.connectors.invoke`.
   There is no model-only scope and no scope narrowing available: the CLI's login server requests
   that exact scope string, hardcoded. **[V]** ([§5](#5-q4---what-is-the-access-tokens-lifetime-and-what-happens-when-it-expires-mid-run))
   **The premise "derive a short-lived token" is false for Codex on a consumer plan.** There is no
   short-lived token to derive.

3. **The reduction shape nevertheless exists in Codex - just not on the CLI.** `auth_mode:
   "chatgptAuthTokens"` is a real, first-party, in-memory-only mode in which a **host process
   supplies the access token and re-supplies it on 401**, and the refresh token never enters Codex
   at all. It is reachable only through the `codex app-server` JSON-RPC `account/login` request, it
   is not plan-gated, and `codex exec` explicitly refuses its refresh callback. **[V]**
   ([§9](#9-the-shape-that-does-exist-chatgptauthtokens-on-the-app-server))

**Exposure consequence: a Codex Plus/Pro Run stays `account`.** ADR 0004's `scoped` requires *"a
model-only credential revocable without disturbing the user's own login."* The best credential any
of these paths can put in the Sandbox fails all three clauses - it is not model-only, it is not
individually revocable, and it outlives the Run by up to ten days. **ADR 0004's table and its
dispatch gate stand unchanged.** ([§11](#11-closing-verdict-exposure-and-what-would-have-to-be-true))

**The biggest single risk, and the reason not to build the ticket's shape even in a variant form:**
host-side refresh consumes a one-time-use refresh token. If a Worker refreshes out of band, the
user's own `~/.codex/auth.json` holds a spent token and their next refresh dead-ends at *"Your
access token could not be refreshed because your refresh token was already used. Please log out and
sign in again."* ([§6](#6-q5---does-host-side-refresh-rotate-the-token-in-a-way-that-invalidates-the-users-own-login))

---

## 2. Q1 - Does `codex login --with-access-token` accept a Plus/Pro-derived access token?

**No. [V]**

### 2.1 What the flag actually is

**[V]** `codex login --help` (0.150.0, run against a throwaway `CODEX_HOME`):

```
      --with-access-token
          Read the access token from stdin (e.g. `printenv CODEX_ACCESS_TOKEN | codex login
          --with-access-token`)
```

**[V]** It is a boolean flag, not a value flag (`codex-rs/cli/src/main.rs:502-506`). The token is
read from **stdin only**, to EOF, then `.trim()`ed (`codex-rs/cli/src/login.rs:284-316`); there is
no flag value, no file path, no environment fallback, and a TTY stdin exits 1. Combining it with
`--with-api-key` is a hard `exit(1)` (`codex-rs/cli/src/main.rs:1556-1578`).

### 2.2 The classifier is a two-way dispatch, and neither branch is "ChatGPT access token"

**[V]** `codex-rs/login/src/auth/access_token.rs` is the whole file:

```rust
const PERSONAL_ACCESS_TOKEN_PREFIX: &str = "at-";

pub(super) enum CodexAccessToken<'a> {
    PersonalAccessToken(&'a str),
    AgentIdentityJwt(&'a str),
}

pub(super) fn classify_codex_access_token(access_token: &str) -> CodexAccessToken<'_> {
    if access_token.starts_with(PERSONAL_ACCESS_TOKEN_PREFIX) {
        CodexAccessToken::PersonalAccessToken(access_token)
    } else {
        CodexAccessToken::AgentIdentityJwt(access_token)
    }
}
```

A ChatGPT access token is a JWT and does not start with `at-`, so it is routed to the **Agent
Identity** branch. That branch does not treat it as a bearer token at all.

### 2.3 Three independent rejections, and the first is offline

**[V]** The Agent Identity JWT must deserialize into `AgentIdentityJwtClaims`
(`codex-rs/agent-identity/src/lib.rs:116-128`):

```rust
pub struct AgentIdentityJwtClaims {
    pub iss: String,
    pub aud: String,
    pub iat: usize,
    pub exp: usize,
    pub agent_runtime_id: String,
    pub agent_private_key: String,
    pub account_id: String,
    pub chatgpt_user_id: String,
    pub email: Option<String>,
    pub plan_type: AuthPlanType,
    pub chatgpt_account_is_fedramp: bool,
}
```

**[V]** And, once JWKS are fetched, it must pass RS256 verification with pinned issuer and audience
(`codex-rs/agent-identity/src/lib.rs:40-41`, `274-289`):

```rust
const AGENT_IDENTITY_JWT_AUDIENCE: &str = "codex-app-server";
const AGENT_IDENTITY_JWT_ISSUER: &str = "https://chatgpt.com/codex-backend/agent-identity";
```

**[V]** The real Plus/Pro access token on this machine, decoded locally (claim *names* and protocol
values only; no secret value read or recorded):

| claim | value |
| --- | --- |
| `iss` | `https://auth.openai.com` |
| `aud` | `["https://api.openai.com/v1"]` |
| `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| `scp` | `["openid","profile","email","offline_access","api.connectors.read","api.connectors.invoke"]` |
| claim namespaces | `https://api.openai.com/auth`, `https://api.openai.com/profile`, `https://api.openai.com/mfa` |
| `alg` | `RS256` |

It carries **none** of `agent_runtime_id`, `agent_private_key`, `account_id`, `chatgpt_user_id`,
`plan_type`, `chatgpt_account_is_fedramp` (all non-`Option` fields), and both `iss` and `aud` are
wrong. So:

1. **Offline, before any network call:** the unverified payload decode at
   `codex-rs/login/src/auth/storage.rs:131-134` deserializes into `AgentIdentityJwtClaims` with
   `jwks: None` and fails on the missing required fields. **[V]** for the code path; **[I]** that
   this is where a real Plus/Pro token dies first, from the claim comparison above.
2. **Issuer/audience mismatch** at JWKS verification. **[V]**
3. **`kid` not in the Agent Identity JWKS** - the token is signed by `auth.openai.com`'s key, not
   the `chatgpt.com/codex-backend/agent-identity` key. **[V]** (`agent-identity/src/lib.rs:274-281`
   errors with `agent identity JWT kid {kid} is not trusted`).

Nothing is written on failure. **[V]** The repo's own test
`login_with_access_token_rejects_unsigned_jwt` (`codex-rs/login/src/auth/auth_tests.rs:962-991`)
asserts rejection, and `login_with_access_token_rejects_invalid_personal_access_token`
(`auth_tests.rs:503-533`) asserts `!get_auth_file(dir.path()).exists()` after a 403.

### 2.4 There is no plan gate in the code - the gate is in the token type

This distinction matters and the ticket half-anticipated it. **[V]** There is **no** plan-tier check
anywhere in the login or load path. `chatgpt_plan_type` is recorded as metadata only
(`codex-rs/login/src/auth/personal_access_token.rs:70-72`, `storage.rs:105`). The only allowlist is
a workspace-id check that is inert unless `forced_chatgpt_workspace_id` or a managed policy is set
(`codex-rs/login/src/server.rs:951-967`).

**[I]** So "Enterprise-gated" is true at the *issuance* layer, not the *acceptance* layer: Codex will
accept any personal access token its `whoami` endpoint honours and any JWKS-valid Agent Identity JWT,
regardless of plan - but a Plus/Pro user has no way to mint either. Which matches the docs
([§8](#8-q7---is-any-of-this-within-openais-documented-support)): *"Codex access tokens are currently
supported for ChatGPT Business and Enterprise workspaces."*

Empirical confirmation is still outstanding - test **T1** in
[§10.2](#102-tests-that-need-the-users-explicit-go-ahead) - but the code makes the outcome
predictable to the point that the test is a formality.

---

## 3. Q2 - What does it write?

**Not an `auth.json` containing an access token. It writes a credential with no `tokens` object at
all. [V]**

**[V]** `codex-rs/login/src/auth/storage.rs:39-65`, the on-disk schema:

```rust
/// Expected structure for $CODEX_HOME/auth.json.
pub struct AuthDotJson {
    pub auth_mode: Option<AuthMode>,
    #[serde(rename = "OPENAI_API_KEY")]
    pub openai_api_key: Option<String>,
    pub tokens: Option<TokenData>,
    pub last_refresh: Option<DateTime<Utc>>,
    pub agent_identity: Option<AgentIdentityStorage>,
    pub personal_access_token: Option<String>,
    pub bedrock_api_key: Option<BedrockApiKeyAuth>,
    pub bedrock_access_keys: Option<BedrockAccessKeysAuth>,
}
```

Every field except `OPENAI_API_KEY` carries `skip_serializing_if = "Option::is_none"`;
`OPENAI_API_KEY` is always emitted, as `null` when absent.

**[V]** What `--with-access-token` writes (`codex-rs/login/src/auth/manager.rs:1013-1049`):

| field | `at-…` (personal access token) | Agent Identity JWT |
| --- | --- | --- |
| `auth_mode` | absent (re-derived by `resolved_mode()`, `manager.rs:1754-1771`) | `"agentIdentity"` |
| `OPENAI_API_KEY` | `null` | `null` |
| `tokens` | **absent** | **absent** |
| `last_refresh` | **absent** | **absent** |
| `agent_identity` | absent | the raw JWT string |
| `personal_access_token` | the `at-…` string | absent |

Asserted by `login_with_access_token_writes_only_personal_access_token`
(`auth_tests.rs:411-460`), which also checks `persisted.get("auth_mode").is_none()`.

**So: `refresh_token` is not written empty, or null, or absent-within-`tokens` - the entire `tokens`
object is absent, and the OAuth refresh machinery is structurally unreachable from this credential.**

**[V] The Agent Identity JWT is worse than a bearer token, not better.** Its `agent_private_key`
claim *is* the signing key. `AgentIdentityAuthProvider::add_auth_headers`
(`codex-rs/model-provider/src/auth.rs:84-110`) signs a **fresh Ed25519 assertion per request**
(`Authorization: AgentAssertion <base64url(envelope)>`, `agent-identity/src/lib.rs:232-245`). Anyone
holding that JWT can mint assertions for the account for the key's lifetime. **[I]** For Reprove that
would be `account`-class regardless of TTL, so even the Business/Enterprise path is not automatically
`scoped` - see [§11](#11-closing-verdict-exposure-and-what-would-have-to-be-true).

**[V] Two file-handling defects worth recording**, `codex-rs/login/src/auth/storage.rs:206-223`:

```rust
let mut options = OpenOptions::new();
options.truncate(true).write(true).create(true);
#[cfg(unix)]
{
    options.mode(0o600);
}
```

- `OpenOptions::mode()` applies **at creation only**. A pre-existing loose-mode `auth.json` is never
  tightened; there is no `set_permissions` anywhere on this path.
- It is a **truncate-in-place write with no atomic rename, no `fsync` of the directory, and no file
  lock**. The only mutual exclusion is an in-process `Semaphore::new(1)` (`manager.rs:2045`). Two
  Codex processes sharing one `CODEX_HOME` interleave load-modify-save with no protection, and a
  concurrent reader can observe a truncated file. **[I]** This is the mechanical reason behind
  OpenAI's written rule *"Do not share the same file across concurrent jobs or multiple machines"*
  ([§8](#8-q7---is-any-of-this-within-openais-documented-support)), and it is a hard constraint on any
  fan-out Worker design.

**[V] Storage backends** (`storage.rs:502-529`): `File`, `Keyring` (Direct or Secrets), `Auto`, and
**`Ephemeral` - a process-local `HashMap` that never touches disk** (`storage.rs:464-500`). The
config key is `cli_auth_credentials_store`, default `"file"` (**[V]** from the packaged-defaults TOML
embedded in the 0.150.0 binary; not set in this machine's `config.toml`).

---

## 4. Q3 - Does `codex exec` run with no refresh token present?

**Yes - and this is the one part of the ticket's premise that holds. [V]**

### 4.1 `exec` and interactive share one auth path

**[V]** Both go through `AuthManager` and `codex-rs/core/src/client.rs`. There is no separate
exec-mode auth loader and no background refresh timer in either. The only exec-specific difference is
that `codex exec` **rejects** the host-driven token-refresh server request
(`codex-rs/exec/src/lib.rs:1867-1875`): `"chatgpt auth token refresh is not supported in exec mode"`.
That is the *externally-managed-token* callback, not the OAuth refresh path - see
[§9](#9-the-shape-that-does-exist-chatgptauthtokens-on-the-app-server), where it becomes decisive.

### 4.2 Refresh is triggered by expiry, not by staleness

**[V]** `AuthManager::should_refresh_proactively` (`manager.rs:2924-2946`):

```rust
if let Some(tokens) = auth_dot_json.tokens.as_ref()
    && let Ok(Some(expires_at)) = parse_jwt_expiration(&tokens.access_token)
{
    return expires_at
        <= Utc::now() + chrono::Duration::minutes(CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES);
}
let last_refresh = match auth_dot_json.last_refresh {
    Some(last_refresh) => last_refresh,
    None => return false,
};
last_refresh < Utc::now() - chrono::Duration::days(TOKEN_REFRESH_INTERVAL)
```

with `TOKEN_REFRESH_INTERVAL = 8` days and `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`
(`manager.rs:188-189`).

**This corrects the prior record.** [#3](https://github.com/nick-neely/reprove/issues/3) recorded the
refresh as an "~8-day interval"; at 0.150.0 the **JWT `exp` is primary** and the 8-day `last_refresh`
rule is only a fallback for a token whose `exp` cannot be parsed. A missing `last_refresh`
**suppresses** refresh rather than forcing it. There is no 28-day constant anywhere.

### 4.3 A hand-built refresh-less ChatGPT `auth.json` does run

**[V]** Requirements, from `codex-rs/login/src/token_data.rs:13-22`, `120-123` and
`manager.rs:549-559`:

- `tokens.refresh_token` is `String` with **no** `#[serde(default)]` - the key must be **present**;
  `""` is accepted, a missing key is a deserialize error.
- `tokens.id_token` is required and must parse as a 3-part JWT with all parts non-empty. Its own
  expiry is never checked for auth purposes (**[V]** the id_token in `~/.codex/auth.json` has a
  1-hour TTL and expired on 2026-08-25; only `parse_jwt_expiration(&tokens.access_token)` feeds the
  refresh decision).
- `last_refresh: Some(_)` is required, or every bearer-token fetch returns `"Token data is not
  available."` **This is the easy trap when generating the file yourself.**

**[V]** If refresh is nevertheless attempted with `refresh_token: ""`, the POST goes out, the
server's `invalid_grant`/400 is classified `Permanent` (`manager.rs:1621-1634`), cached by
`record_permanent_refresh_failure_if_unchanged` (`manager.rs:2854-2858`) so later attempts fail fast
with no network call, and `auth()` logs and returns the stale auth anyway (`manager.rs:2352-2358`):

```rust
tracing::error!("Failed to refresh token: {}", err);
return Some(auth);
```

**No panic, no hang.** The request proceeds on the existing access token.

**[I] So the mechanically viable version of the ticket's shape is not `--with-access-token` at all -
it is the Worker writing a `chatgpt`-mode `auth.json` into the Sandbox's `CODEX_HOME` containing
`id_token`, `access_token`, `refresh_token: ""`, `account_id`, and `last_refresh: <now>`.** That runs.
It is also still `account`-class, for the reasons in
[§5](#5-q4---what-is-the-access-tokens-lifetime-and-what-happens-when-it-expires-mid-run) and
[§11](#11-closing-verdict-exposure-and-what-would-have-to-be-true). Empirical confirmation is test
**T3**.

---

## 5. Q4 - What is the access token's lifetime, and what happens when it expires mid-Run?

### 5.1 Ten days, and account-scoped

**[V]** Decoded from `~/.codex/auth.json` on this machine (timestamps and protocol claims, not
secrets):

```
iat = 1787619364  ->  2026-08-25T00:56:04Z
exp = 1788483364  ->  2026-09-04T00:56:04Z
exp - iat = 864000s = 10 days
nbf == iat
```

`last_refresh` = `2026-08-25T00:56:04.785Z`, i.e. the token is minted at refresh and lives ten days,
with the CLI refreshing at the 8-day `last_refresh` mark or 5 minutes before `exp`, whichever fires
first.

**[V] The scope set is not model-only and cannot be narrowed.** The access token's `scp` is
`openid profile email offline_access api.connectors.read api.connectors.invoke`, and the CLI's login
server requests exactly that string, hardcoded - it is present verbatim as a single literal in the
0.150.0 binary, adjacent to `codex-rs/login/src/server.rs` symbols:

```
openid profile email offline_access api.connectors.read api.connectors.invoke
```

**[I]** `api.connectors.invoke` in particular is authority beyond model requests, and `profile` /
`email` are read access to the user's identity. A token bearing these is not *"a model-only
credential"* in ADR 0004's sense, whatever its TTL.

**[V]** `client_id` is `app_EMoamEEZ73f0CkXaXp7hrann` - the same literal appears in the binary and at
`manager.rs:1710`, confirming the CLI is the OAuth client that minted this token.

### 5.2 There is no TTL assumption in the code

**[V]** No hardcoded TTL anywhere. For ChatGPT auth the code reads `exp` off the token. For personal
access tokens there is **no expiry handling at all** - no `exp` parse, no proactive refresh; the
token is used until the server rejects it. For Agent Identity, `exp` is enforced at load-time JWKS
verification and then **stops mattering**, because per-request auth is a freshly signed assertion,
not the JWT.

### 5.3 Mid-Run expiry: clean failure, not a hang - but the granularity is per-request, not per-stream

**[V]** `codex-rs/core/src/client.rs:989-1009` (`current_client_setup()`, called at eight sites:
lines 578, 680, 705, 732, 1053, 1338, 1481, 1626) resolves auth on every request/stream
*construction*, then **snapshots** the token into a `BearerAuthProvider`
(`codex-rs/model-provider/src/auth.rs:305-324`). A long-lived SSE stream therefore holds one token
for the life of that stream. The 5-minute pre-expiry window is what normally keeps that safe.
`AuthManagerAuthProvider`, which re-resolves per header call, is wired only into exec-server remote
registration (`codex-rs/cli/src/main.rs:2035`) and the MCP connection manager - **not** the model
request path.

**[I] Consequence for a Run that can last ~20 minutes and a Pass that can be long:** with a
refresh-capable credential the CLI refreshes 5 minutes early and the Run survives. With a
refresh-less credential injected near the end of the token's ten days, the failure sequence is:
proactive refresh fires inside the 5-minute window → POST fails → classified `Permanent`, cached →
the run continues on the stale token → the server 401s → `supports_unauthorized_recovery()` attempts
a refresh that also fails → **the Pass fails with an error message; it does not hang.** The
user-facing string is *"Your access token could not be refreshed. Please log out and sign in
again."* (`manager.rs:192` and neighbours, present verbatim in the shipped binary). **[V]** for each
mechanism; **[I]** for the sequencing. Test **T3** would settle the sequencing empirically.

**[I] Design consequence if this shape were ever built:** the Worker must refuse to dispatch a Run
whose injected access token expires within the Run's wall-clock budget, because the Sandbox cannot
recover. That is a real, checkable precondition - `exp` is readable host-side - and it is cheap.

---

## 6. Q5 - Does host-side refresh rotate the token in a way that invalidates the user's own login?

**Yes, on the strength of the evidence available without performing a rotation. Treat this as a
blocker. [V]** mechanically, **[I]** on the server contract, and corroborated by OpenAI's own docs.

### 6.1 What the client does, mechanically

**[V]** `POST https://auth.openai.com/oauth/token`, JSON body
`{client_id, grant_type: "refresh_token", refresh_token}` (`manager.rs:1584-1596`, `1697-1701`,
`1717-1720`), overridable via `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.

**[V]** `persist_tokens` (`manager.rs:1555-1579`) is load-modify-save; each of `id_token`,
`access_token`, `refresh_token` in `RefreshResponse` is `Option<String>` and applied only if present,
and `last_refresh` is always stamped:

```rust
if let Some(refresh_token) = refresh_token {
    tokens.refresh_token = refresh_token;
}
auth_dot_json.last_refresh = Some(Utc::now());
storage.save(&auth_dot_json)?;
```

**[V] So: if a Worker refreshes using a copy of the user's `auth.json` and does not write back to
`~/.codex/auth.json`, the user's file retains the pre-refresh refresh token and the Worker's copy
holds the new one.** That much is purely mechanical.

### 6.2 Whether the user's now-stale token still works

**[V]** The client's error taxonomy (`manager.rs:1636-1649`):

```rust
Some("refresh_token_expired")     => RefreshTokenFailedReason::Expired,
Some("refresh_token_reused")      => RefreshTokenFailedReason::Exhausted,
Some("refresh_token_invalidated") => RefreshTokenFailedReason::Revoked,
```

with the user-facing string at `manager.rs:192`, also present verbatim in the 0.150.0 binary:

> "Your access token could not be refreshed because your refresh token was already used. Please log
> out and sign in again."

**[I]** A distinct `refresh_token_reused` → **terminal** state, sitting alongside a separate
`refresh_token_invalidated`, is the OAuth 2.1 / RFC 6819 reuse-detection pattern. Under that model an
out-of-band Worker refresh consumes the token and the user's next refresh dead-ends at
`RefreshTokenError::Permanent`, which `record_permanent_refresh_failure_if_unchanged`
(`manager.rs:2854-2858`) then **caches**, so the user's CLI stops even retrying until they re-login.
This is inference from error-code naming, not an observed server contract. Note also the code's own
comment at `manager.rs:1616-1617` that the backend now often collapses these into a bare
`invalid_grant`, which would make the failure harder to attribute in practice.

**[V] But OpenAI states the operational consequence directly**, on
[learn.chatgpt.com/docs/auth/ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), naming as a
reseed trigger:

> "another machine or concurrent job rotated the token first"

and as an operational rule:

> "Use one `auth.json` per runner or per serialized workflow stream. Do not share the same file
> across concurrent jobs or multiple machines."

**[I] Together these are sufficient to decide the design question without running the test.** A
Worker performing a host-side refresh against the same credential the user's interactive CLI holds
is precisely "another machine rotated the token first," and OpenAI's own remedy for that state is
"reseed" - i.e. the user logs in again. **A design that silently logs the user out of their own CLI
is worse than the co-location it replaces**, which is the ticket's own standard, and this clears it.

**[I] The one mitigation that would work is unattractive:** the Worker writes the rotated tokens back
into `~/.codex/auth.json`, becoming a co-owner of the user's live credential file - with no file
locking and a non-atomic truncate-in-place write ([§3](#3-q2---what-does-it-write)) - and thereby
reintroduces exactly the co-location ADR 0004 already accepted, plus a corruption race.

**Empirical confirmation is test T4, and it must never be run against the user's own account.**
See [§10.2](#102-tests-that-need-the-users-explicit-go-ahead).

---

## 7. Q6 - Does the same shape exist for Claude Code and OpenCode?

**Neither needs the Codex shape, and neither offers it - for opposite reasons.** Claude Code already
performs a *different* reduction that makes the host-side refresh dance unnecessary. OpenCode
performs no reduction at all, because it has none to give.

Sources for this section: Claude Code and OpenCode both ship as Bun-compiled single-file ELF
executables with their JavaScript bundle embedded as readable text. Findings tagged **[V] (bundle)**
are exact strings from the shipped artifact - they are **minified internals, not a documented
contract**; they corroborate and must never be built on. OpenCode source was read at tag `v1.18.25`.

### 7.1 Claude Code - the reduction is scope, not time

**[V]** [code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication),
"Generate a long-lived token", verbatim:

> "For CI pipelines, scripts, or other environments where interactive browser login isn't available,
> generate a **one-year OAuth token** with `claude setup-token`"
> "The command opens the same browser authorization flow as `/login`, and the token prints to the
> terminal after you approve access in the browser. **It does not save the token anywhere**; copy it
> and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to
> authenticate"
> "This token authenticates with your Claude subscription and **requires a Pro, Max, Team, or
> Enterprise plan**. **It can only make model requests, so it can't establish Remote Control sessions
> or fetch claude.ai connectors.** MCP servers you configure locally still work."

**All three claims in ADR 0004's Claude Code row are verbatim-verified.** So is the `--bare`
consequence, from the same page:

> "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. If your script passes `--bare`, authenticate
> with `ANTHROPIC_API_KEY` or an `apiKeyHelper` instead."

**[V]** Independently corroborated by local `claude --help`, which is worth adding to the ADR as a
second citation because it survives doc reorganisation:

> "`--bare`  Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background
> prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`. **Anthropic
> auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via `--settings` (OAuth and keychain are never
> read).**"

**[V] Why the Codex shape is unnecessary here.** The Codex shape is *time* reduction: keep a
refresh-capable credential on the host, inject a short-lived derived token. `setup-token` is *scope*
reduction: the credential it hands you is inference-only and **carries no refresh capability at
all**, so there is nothing for a host-side dance to protect. **[V] (bundle)**, the credential
constructed from the env var:

```js
if(a.CLAUDE_CODE_OAUTH_TOKEN) return {accessToken:a.CLAUDE_CODE_OAUTH_TOKEN,
  refreshToken:null, expiresAt:null, scopes:PN(), ...}
```

with the default scope set `["user:inference"]`, and two runtime enforcement messages that are
stronger evidence than the prose:

> "Remote Control requires a full-scope login token. Long-lived tokens (from `claude setup-token` or
> CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons."
> "[Claude in Chrome] Disabled: OAuth token has no scope accepted by /api/oauth/validate (needs
> user:profile, user:office, or user:ccr_inference; env-var and setup-token sessions default to
> user:inference only)"

**[V]** Contrast with the interactive credential at `~/.claude/.credentials.json` (mode `0600`; key
names only, no values read): `claudeAiOauth.{accessToken, refreshToken, expiresAt,
refreshTokenExpiresAt, scopes[0..4], subscriptionType, rateLimitTier}`, plus
`mcpOAuth.<server>.{accessToken, clientId, clientSecret, …}`. **Five scopes and a refresh token
versus one scope and no refresh token - that single contrast is the whole `account` / `scoped`
distinction, evidenced from the artifact.** It also means a mounted `.credentials.json` leaks every
MCP server's OAuth client secret alongside the Anthropic credential.

**Is there anything Reprove would want beyond `setup-token`? Four findings, three of them cautions.**

1. **A shorter-lived or model-restricted OAuth token: NOT FOUND.** No documented flag, env var, or
   endpoint. **[V] (bundle)** the 365-day figure is **server-supplied**, not hardcoded - the CLI
   renders `n.days===365?"1-year":`${n.days}-day`` and passes `expiresIn: n.seconds` into the flow,
   with internal `SETUP_TOKEN_DEFAULT_EXPIRY_DAYS` / `SETUP_TOKEN_MAX_EXPIRY_DAYS` constants and a
   `parseSetupTokenExpiryDays` export - **but nothing user-facing exposes it in 2.1.251.** Treat
   "one year, not shortenable" as correct for Reprove today, and as a thing that may become
   configurable.
2. **The only documented rotation seam is `apiKeyHelper`.** **[V]** *"by default, `apiKeyHelper` is
   called after 5 minutes or on HTTP 401 response. Set `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`
   environment variable for custom refresh intervals."* **[I]** It is also the **only** path that
   survives `--bare`, so it is the only thing that would resolve ADR 0004's recorded consequence that
   `--bare` and user-managed authentication are mutually exclusive - **at the cost of moving off the
   subscription onto Console billing**, which is the whole point of the Native Route. Recorded, not
   recommended.
3. **Per-run API-key minting is not automatable. [V]** The Admin API documents exactly two API-key
   operations - List (`GET /v1/organizations/api_keys`) and Update (`POST
   /v1/organizations/api_keys/{id}`, `status`/`name` only) - and key creation is Console-UI-only:
   *"**Create a key:** Go to Settings → API keys in the Claude Console and click **Create key**."*
   A pool would have to be pre-provisioned. Workspace-scoped keys exist and carry spend and rate
   limits (*"**Spend limits:** Cap monthly spending for a workspace"*), but **per-key model
   restriction: NOT FOUND** - only per-model-*tier* rate limiting.
4. **Anthropic itself uses host-brokered token injection, undocumented. [V] (bundle)** The bundle
   contains `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_HOST_CREDS_FILE`,
   `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS`,
   `CLAUDE_CODE_OAUTH_401_WAIT_MS`, `CLAUDE_CODE_OAUTH_SCOPES` - an SDK `getOAuthToken` callback that
   rewrites `process.env.CLAUDE_CODE_OAUTH_TOKEN` on 401, a poll loop that waits "for a rotated env
   token", and a host-managed credentials file the permission layer explicitly protects (*"The host
   credentials file is managed by the host process; it cannot be written directly"*). **[V]** None
   appear on
   [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars). **This is exactly
   the ticket's shape, shipped and used by Anthropic's own cloud host, and entirely undocumented.**
   **[I] Record its existence as evidence the pattern is real; do not build on it.**

**[V] A governance gap worth adding to ADR 0004**, from the authentication page, "Restrict login to
your organization":

> "**`claude setup-token` and `/install-github-app`**: enforce only `forceLoginMethod`, so **they
> can mint a token in a different organization**"

An enterprise that pins `forceLoginOrgUUID` cannot use it to constrain which org a Reprove Worker's
setup-token belongs to.

**[V] Revocation is weaker than ADR 0004's `scoped` definition assumes.**
[support.claude.com/en/articles/10310342](https://support.claude.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions):

> "If you used your Claude account to authenticate into Claude Code, you can manage your
> authorization tokens by navigating to **Settings > Claude Code**"

with a trash icon per token, at `claude.ai/settings/claude-code`, distinct from Settings > Account >
"Log Out" which signs out all devices. **[I]** Per-token deletion implies a setup-token is revocable
without disturbing the interactive `/login` credential - a setup-token is a separate grant with a
distinct scope set, and `/logout` is documented only as managing the local `.credentials.json`, which
a setup-token by construction never enters. **[V] But Anthropic nowhere states this**, does not
document what that page lists, and does not state whether revocation is immediate;
[code.claude.com/docs/en/security](https://code.claude.com/docs/en/security) does not mention
credential revocation at all. There is also a **community-reported, unverified** issue
(`anthropics/claude-code#43801`) alleging claude.ai-side revocation did not invalidate an OAuth
token. **[I] Consequence for ADR 0004: the "revocable without disturbing the user's own login" half
of the `scoped` definition is inferred for Claude Code, not documented.** `SECURITY.md` should say
revocation is user-driven through a Console surface Anthropic does not document, rather than
asserting revocability as a Reprove property.

### 7.2 OpenCode - a pure pass-through, so all narrowing is provider-side

ADR 0004 records OpenCode only as *"the narrowest supported configured provider credential."* That
reads as vague because **the narrowness is not OpenCode's to give.**

**[V] The credential mechanism**, type definitions byte-identical in source
(`packages/opencode/src/auth/index.ts:14-35`, tag `v1.18.25`) and in the shipped binary:

```js
class OAuth   { type:"oauth",     refresh, access, expires, accountId?, enterpriseUrl? }
class ApiAuth { type:"api",       key, metadata? }
class WellKnownAuth { type:"wellknown", key, token }
```

Three variants, discriminator `type`. Store is `Global.Path.data + "/auth.json"` →
`$XDG_DATA_HOME/opencode/auth.json`, default `~/.local/share/opencode/auth.json`, written
`writeJson(file, data, 0o600)` with a post-write chmod. **[V]** Verified live: `-rw------- 3531
bytes`; a missing file reads as `{}`.

**[V] The live file on this machine holds seven providers** (`anthropic`, `clarifai`,
`github-copilot`, `google`, `kimi-for-coding`, `nvidia`, `openai`), a mix of `oauth`-shaped and
`api`-shaped entries - **key names and value types only, no values read**. Two facts follow, and both
matter:

- **`Auth.all()` reads every entry together.** Mounting `auth.json` into a Sandbox exposes every
  provider the user has ever connected, not the one the Run needs.
- **Entries accumulate with no expiry sweep.** The file holds `anthropic` and `google` **oauth**
  entries the current build can no longer even mint (see below).

**[V] Environment-variable-only credentials are supported and are the documented automation path.**
`provider.env` comes from models.dev (`provider.ts:1335-1343`); the loader merges env-sourced keys
*before* `auth.json` `type:"api"` entries. Confirmed live against models.dev: `anthropic.env =
["ANTHROPIC_API_KEY"]`, `openai.env = ["OPENAI_API_KEY"]`, `google.env = ["GOOGLE_API_KEY",
"GOOGLE_GENERATIVE_AI_API_KEY","GEMINI_API_KEY"]`, `opencode.env = ["OPENCODE_API_KEY"]` (Zen).
Precedence is explicit config `provider.<id>.options.apiKey` > `auth.json` `type:"api"` > plain env
var, documented as *"Configuration file options take precedence over environment variables"*. OpenCode's
own GitHub Action docs use `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}` in all five worked
examples. **There is no OpenCode analogue of `setup-token`: no derived, scope-reduced, harness-issued
credential exists.**

**[V] Undocumented: `OPENCODE_AUTH_CONTENT`** (`auth/index.ts:58-63`) - an env var holding an entire
`auth.json`-shaped JSON blob, taking precedence over the file, letting OpenCode run with exactly one
provider entry and nothing on disk. **[V]** It is documented nowhere under
`packages/web/src/content/docs/`, it **bypasses schema validation** (the decode pass runs only on the
disk path), and OpenCode's own use of it (`control-plane/workspace.ts:527-531`) serializes
`auth.all()` **wholesale**. **[I]** Reprove would have to construct a single-provider blob by hand;
the single models.dev env var is the safer default and needs no OpenCode-specific plumbing.

**[V] A widely-repeated claim to correct: OpenCode does not support Anthropic Claude Pro/Max login.**
`providers.mdx:356-361` at this tag:

> ":::info There are plugins that allow you to use your Claude Pro/Max models with OpenCode.
> **Anthropic explicitly prohibits this.** Previous versions of OpenCode came bundled with these
> plugins but that is no longer the case **as of 1.3.0** … you can use the following subscriptions in
> OpenCode with zero setup: - ChatGPT Plus - Github Copilot - Gitlab Duo"

The code matches: `plugin/index.ts:67-85` registers `CodexAuthPlugin`, `CopilotAuthPlugin`,
`GitlabAuthPlugin`, `PoeAuthPlugin` and cloud providers - **no Anthropic, no consumer Google**.

**[V] For the OAuth providers that do exist, OpenCode stores a refresh token and refreshes in-process,
writing back to disk** (`plugin/openai/codex.ts:338-393`, same pattern in
`github-copilot/copilot.ts:281-298`). **[I]** That is the same self-renewing-credential problem ADR
0004 already names for Codex's `auth.json`: an `oauth`-type OpenCode credential requires **write**
access back to the store, and a compromised Sandbox gets a refresh token, not just a bearer.

**[I] Exposure classification for OpenCode**, which is the concrete rule that should replace "per
credential":

| Option | Exposure | Why |
| --- | --- | --- |
| Brokered Route (placeholder + transformation) | `none` | Nothing usable inside |
| **Dedicated provider API key via that provider's single models.dev env var, no `auth.json` in the Sandbox** | **`scoped`** | Model-only by construction; revocable at the provider console with no effect on the user's OpenCode login or any other provider. **This is the recommended Native-Route credential.** |
| OpenCode Zen key (`OPENCODE_API_KEY`) | `scoped` | Separate prepaid balance, separately revocable, dollar-capped |
| Same key via `OPENCODE_AUTH_CONTENT` (single provider) | `scoped` | Equivalent blast radius; undocumented, so avoid |
| Reusing the user's primary provider key | `account` | Revoking it breaks the user's other tools |
| `auth.json` mounted into the Sandbox | `account` | `Auth.all()` reads every provider entry, including stale refresh-token-bearing oauth grants |
| An `oauth`-type credential (ChatGPT / Copilot / GitLab Duo) | `account` | Refresh token present, refreshed in-process, written back |

**[V] Two corrections ADR 0004 should absorb.**

- The ADR says *"OpenCode has no sandbox at all **and says so**."* The first half is verified - a
  repo-wide grep for `seccomp|bubblewrap|bwrap|landlock|namespaces|chroot` at `v1.18.25` returns only
  unrelated hits, and once a tool call is approved it runs as an ordinary child process with the
  invoking user's full privileges. **[V] The second half is not**: no doc page at `v1.18.25` states
  that OpenCode is not a sandbox. Either soften to "and ships nothing that claims otherwise," or
  re-cite whatever source in #3 supported "says so."
- **[I]** On OpenCode a **model allowlist is enforceable at the proxy but not at the credential**
  (config `blacklist` is a UI picker filter, not a control), and a **spend budget only where the
  provider offers one** - Zen and a workspace-scoped Anthropic key do; a raw OpenAI key does not.
  That refines ADR 0004's per-Run limits clause.

**[V] OpenCode reads the credential lazily and on the hot path**: `auth.get(providerID)` is called
inside `LLM.run` (`session/llm.ts:76,100`) on **every** request, with no caching in `Auth.Service` -
each call re-reads `auth.json` or re-parses `OPENCODE_AUTH_CONTENT`. **[I]** An env-var credential
could in principle be rotated between requests, but there is no documented rotation hook, so this is
a property, not a feature. **[V]** `opencode serve` does not help: the single server process holds
the credential, calls the model, *and* executes `bash`/`edit`; `OPENCODE_SERVER_PASSWORD` is HTTP
Basic auth on OpenCode's own API and is unrelated to provider credentials. Consistent with #3's
finding that OpenCode exposes no tool-execution seam.

### 7.3 The structural asymmetry, stated once

**[I]** Claude Code offers a **harness-side** reduction - `setup-token` narrows an account credential
to inference-only, and Anthropic documents and supports it. Codex offers a harness-side reduction
too, but only for Business/Enterprise, and its consumer path has none. OpenCode offers **no**
harness-side reduction at all: it is a pure pass-through to a provider credential, so every bit of
narrowing must come from the provider side and every bit of revocability lives in the provider's
console. **That is why ADR 0004's three rows read so differently, and it is not an inconsistency in
the ADR.**

---

## 8. Q7 - Is any of this within OpenAI's documented support?

**Reported strictly as stated / silent / ambiguous.** Where OpenAI has written nothing, the finding
is *silent*, not *prohibited* - [#18](https://github.com/nick-neely/reprove/issues/18) was withdrawn
for exactly that error and this section is written to avoid repeating it. Doc quotes are from the
`.md` sources of `learn.chatgpt.com/docs/*`, fetched **2026-08-30**. `openai.com/policies/*` and
`help.openai.com` returned **HTTP 403** to direct fetch; those four documents were read from
**Wayback captures of OpenAI's own pages**, with capture dates noted - archived copies of the primary
source, not live fetches.

### 8a. STATED

**`CODEX_ACCESS_TOKEN` is plan-gated, in prose and in the feature matrix. [V]**
[learn.chatgpt.com/docs/enterprise/access-tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens):

> "Codex access tokens are currently supported for ChatGPT Business and Enterprise workspaces."

Corroborated by [learn.chatgpt.com/docs/pricing](https://learn.chatgpt.com/docs/pricing), row *"Codex
access tokens for trusted automation"*: `plus: unavailable, pro: unavailable, business: available,
enterprise: available, api: unavailable`. Service accounts are further gated: *"Service accounts are
available only on pay-as-you-go plans."*

**`codex login --with-access-token` is documented, and documented as writing an agent identity. [V]**
Same page:

> "For a persistent local login, pipe the token to `codex login --with-access-token`"
> "`codex login --with-access-token` stores an agent identity credential in Codex CLI auth storage.
> If you prefer not to persist credentials on the machine, use the `CODEX_ACCESS_TOKEN` environment
> variable instead."

**[V] This corroborates [§2](#2-q1---does-codex-login---with-access-token-accept-a-pluspro-derived-access-token)
from the vendor's own words:** the flag's product meaning is *agent identity*, not *bearer token*.

Environment-variable reference
([learn.chatgpt.com/docs/config-file/environment-variables](https://learn.chatgpt.com/docs/config-file/environment-variables)):

> "`CODEX_ACCESS_TOKEN` | CLI, app-server, trusted automation | Provides a ChatGPT or Codex access
> token for trusted automation. For persisted login, pipe it to `codex login --with-access-token`."

**Token lifetime and refresh cadence. [V]**
[learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth):

> "For sign in with ChatGPT sessions, Codex refreshes tokens automatically during use before they
> expire, so active sessions usually continue without requiring another browser login."

and [.../auth/ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), the only numeric
statement, explicitly scoped to client behaviour:

> "As of the current open-source client: Codex loads the local auth cache from `auth.json`; if
> `last_refresh` is older than about 8 days, Codex refreshes the token bundle before the run
> continues; after a successful refresh, Codex writes the new tokens and a new `last_refresh` back
> to `auth.json`; if a request gets a `401`, Codex also has a built-in refresh-and-retry path"

**[V] The docs are behind the code here.** At 0.150.0 the JWT `exp` is primary and the 8-day rule is
a fallback ([§4.2](#42-refresh-is-triggered-by-expiry-not-by-staleness)). Where they disagree, the
code is authoritative and the docs' own hedge - *"as of the current open-source client"* - concedes
it. **OpenAI does not commit to a server-side token lifetime**, and adds:

> "This flow reduces manual work, but it does not guarantee the same session lasts forever."

**The `auth.json`-on-a-runner pattern is documented and supported, with conditions. [V]** OpenAI
ships a dedicated page teaching it, *"Maintain Codex account auth in CI/CD (advanced)"*, plus a
working GitHub Actions YAML, plus literal `scp` and `docker cp` commands for copying `auth.json` to a
headless machine or into a container ([.../auth](https://learn.chatgpt.com/docs/auth), "Fallback:
Authenticate locally and copy your auth cache"). Its conditions, verbatim:

> "you need ChatGPT-managed Codex auth rather than an API key; `codex login` cannot run on the remote
> runner; the runner is trusted private infrastructure; you can preserve the refreshed `auth.json`
> between runs; only one machine or serialized job stream will use a given `auth.json` copy"

and its scope disclaimer, which is where `chatgptAuthTokens` gets its public name:

> "This guide applies to Codex-managed ChatGPT auth (`auth_mode: "chatgpt"`). It does not apply to:
> API key auth; external-token host integrations (`auth_mode: "chatgptAuthTokens"`); generic OAuth
> clients outside Codex."

**The written prohibitions, and only these. [V]**

> "Treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it, paste it
> into tickets, or share it in chat. **Do not use this workflow for public or open-source
> repositories.**"
> "Use one `auth.json` per runner or per serialized workflow stream. Do not share the same file
> across concurrent jobs or multiple machines. Do not overwrite a persistent runner's refreshed file
> from the original seed on every run. Do not store `auth.json` in the repository, logs, or public
> artifact storage."

**Credential exposure inside a container. [V]**
[learn.chatgpt.com/docs/agent-approvals-security](https://learn.chatgpt.com/docs/agent-approvals-security):

> "Devcontainers provide substantial protection, but they do not prevent every attack. If you run
> Codex with `--sandbox danger-full-access` or `--dangerously-bypass-approvals-and-sandbox` inside
> the container, a malicious project can exfiltrate anything available inside the devcontainer,
> **including Codex credentials**. Use this pattern only with trusted repositories."

**Terms of Use. [V]** Wayback capture 2026-08-25 of
[openai.com/policies/row-terms-of-use](https://openai.com/policies/row-terms-of-use/):

> "You may not share your account credentials or make your account available to anyone else and are
> responsible for all activities that occur under your account."
> "…Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or
> bypass any protective measures or safety mitigations we put on our Services."

**[I]** *"anyone else"* is written about **other people**. OpenAI's own docs instruct users to place
`auth.json` on their own trusted runner and inside their own container, so OpenAI plainly does not
read its own clause as covering that. Do not stretch it. The rate-limit clause bites only on
*evasion*; consuming a plan within its limits is not, on the written text, circumvention, and OpenAI
does not say otherwise.

**Account sharing help article. [V]** Wayback capture 2026-03-27 of
[help.openai.com/en/articles/10471989](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy):

> "**How Many Devices Can Use My Account?** You are welcome to use your OpenAI account on multiple
> devices. However, please note that usage limits may apply depending on your account activity and
> subscription level."

Permissive, qualified only by usage limits.

### 8b. AMBIGUOUS

**[V]** [learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth):

> "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose
> Codex execution in untrusted or public environments."

**[I]** Unchanged from [`provider-auth-and-usage.md`](provider-auth-and-usage.md) §5: *"untrusted or
public environments"* is never disambiguated, the register is the soft *"Don't"*, and both readings -
infrastructure trust, or target-repository visibility - remain available. Record both; do not resolve
it in Reprove's favour.

**[V]** Terms of Use: *"Automatically or programmatically extract data or Output."* **[I]** Read
broadly this would forbid the Codex CLI itself, which OpenAI ships and documents. The operative
reading is scraping/harvesting. **Do not lean on it.**

### 8c. SILENT - and silent means silent

**[V]** Searched: `auth`, `auth/ci-cd-auth`, `non-interactive-mode`, `github-action`, `pricing`
(including FAQ and the full feature matrix), `enterprise/access-tokens`,
`enterprise/service-accounts`, `config-file/environment-variables`, `agent-approvals-security`,
`cloud`; plus Usage Policies (zero occurrences of "credential") and Service Terms (zero occurrences
of "credential", "account sharing", "automat", "headless", "subscription").

- **No sentence restricts the `auth.json` CI/CD pattern to Business/Enterprise plans.** The plan gate
  is written for *access tokens* and *service accounts* only. The `auth.json` page says "enterprise
  and other trusted private automation" - *"and other"* is doing real work.
- **Nothing states that using a Plus/Pro subscription for automated or headless workloads is
  disallowed, discouraged, or limit-circumvention.** The pricing page states per-plan limits and says
  nothing about whether a message was human- or machine-originated.
- **Nothing addresses deriving, extracting, or reducing a credential outside the CLI** - neither
  permitting nor forbidding it. **This ticket's whole question is unaddressed by OpenAI.**
- The GitHub Action's docs are API-key-only. That is **silence about ChatGPT-credential use in the
  Action**, not a prohibition.

**[V] One affirmative sentence points the other way**, from
[learn.chatgpt.com/docs/non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode),
in the collapsed *"Use ChatGPT-managed auth in CI/CD (advanced)"* section:

> "Read this if you need to run CI/CD jobs with a Codex user account instead of an API key, such as
> enterprise teams using ChatGPT-managed Codex access on trusted runners **or users who need
> ChatGPT/Codex rate limits instead of API key usage**."

Not plan-qualified. **[I]** This is the closest thing to an affirmative statement that subscription
rate limits backing automation is a contemplated use case.

### 8d. Reprove's posture, unchanged

**[I]** The Native Auth Route for Codex should be described as **documented and supported, never
recommended** - OpenAI says API keys are "the right way" for automation, and workload identity
federation where the platform issues short-lived tokens. That is the wording
[`provider-auth-and-usage.md`](provider-auth-and-usage.md) already settled and nothing found today
moves it.

**[I] The one documented line a Reprove Worker design would actually violate** is the concurrency
rule: *"Use one `auth.json` per runner or per serialized workflow stream."* A Worker that dispatches
two Runs concurrently against one Codex credential violates it, and
[§3](#3-q2---what-does-it-write) explains why it is a real constraint rather than boilerplate -
there is no file locking and the write is a non-atomic truncate-in-place. **This is a
[#17](https://github.com/nick-neely/reprove/issues/17) input.**

---

## 9. The shape that does exist: `chatgptAuthTokens` on the app-server

**This is the widening the ticket hoped for, and it is real - it is just not on the CLI. [V]**

**[V]** `AuthMode::ChatgptAuthTokens` is one of eight modes (`ApiKey`, `Chatgpt`, `ChatgptAuthTokens`,
`Headers`, `AgentIdentity`, `PersonalAccessToken`, `BedrockApiKey`, `BedrockAccessKeys`). OpenAI names
it in its own docs as *"external-token host integrations (`auth_mode: "chatgptAuthTokens"`)"*
([§8a](#8a-stated)).

**[V]** `AuthDotJson::from_external_access_token` (`manager.rs:1723-1751`) constructs exactly the
credential the ticket asked for:

```rust
let tokens = TokenData {
    id_token: token_info,                 // parsed from the access token's own claims
    access_token: access_token.to_string(),
    refresh_token: String::new(),
    account_id: Some(chatgpt_account_id.to_string()),
};
Ok(Self {
    auth_mode: Some(AuthMode::ChatgptAuthTokens),
    ...
    last_refresh: Some(Utc::now()),
```

It calls `parse_chatgpt_jwt_claims` on the **access token**, i.e. it expects the ChatGPT claim
namespace that a Plus/Pro token actually has - **[V]** the real token carries
`https://api.openai.com/auth` and `https://api.openai.com/profile`, which is what
`IdClaims`/`ProfileClaims` (`codex-rs/login/src/token_data.rs:28-99`) read. **No separate `id_token`
is needed and no refresh token is needed.**

**[V]** It is stored `Ephemeral` - a process-local `HashMap`, **never written to disk**
(`manager.rs:1090-1102`, `storage.rs:464-500`).

**[V]** The entry point is the app-server JSON-RPC `account/login` request with
`LoginAccountParams::ChatgptAuthTokens { access_token, chatgpt_account_id, chatgpt_plan_type }`
(`codex-rs/app-server/src/request_processors/account_processor.rs:327-338`, `845-879`). The only gate
is the workspace allowlist, inert by default:

```rust
if let Some(expected_workspaces) = self.auth_manager.effective_chatgpt_workspaces()
    && !expected_workspaces.contains(&chatgpt_account_id)
```

**No plan check.**

**[V]** When a request 401s, the server asks **the host** for a new token
(`codex-rs/app-server/src/external_auth.rs:33-80`): a `ChatgptAuthTokensRefresh` server-request with
`reason: Unauthorized`, a **10-second timeout**, and a response of
`{access_token, chatgpt_account_id, chatgpt_plan_type}`. It is careful not to log the response
(*"Don't log err.message because it may contain a token"*). Refresh is excluded from both
`should_refresh_proactively` and `refresh_token_from_authority_impl` for this mode - **Codex never
touches `auth.openai.com` in `chatgptAuthTokens` mode.**

### 9.1 Why this is not a shippable answer today

**[V] `codex exec` refuses the callback** (`codex-rs/exec/src/lib.rs:1867-1875`):
`"chatgpt auth token refresh is not supported in exec mode"`. So the host-refresh half of the
mechanism exists only for an app-server-driven session.

**[I]** Adopting it would mean the Codex Adapter drives `codex app-server` JSON-RPC instead of
`codex exec`. That surface is marked `[experimental]` in `codex --help`, and ADR 0004 already
declined `codex exec-server` on materially the same grounds - experimental, Codex-only, and it
fractures the Adapter seam [#11](https://github.com/nick-neely/reprove/issues/11) exists to hold
together. **The same objection applies here and should be applied consistently.**

**[I] And it would not change `Exposure` anyway.** The token the host injects is still the ten-day,
`api.connectors.invoke`-bearing account token from
[§5.1](#51-ten-days-and-account-scoped). What `chatgptAuthTokens` removes is the **refresh token**
and the **on-disk credential** - genuinely valuable defence in depth, and a strictly weaker
`account`, but not `scoped`.

**Record it, do not build it yet.** Revisit if app-server graduates from experimental, or if OpenAI
ever issues a Codex token whose scope is model-requests-only.

### 9.2 Adjacent finding, recorded not pursued

**[V]** Codex 0.150.0 ships a **first-party credential broker inside its network proxy** -
`codex-rs/network-proxy/src/credential_broker.rs`, with per-provider modules
`credential_broker/providers/{github,openai}.rs`, MITM hooks configured as
`network.mitm_hooks[N].actions.inject_request_headers` / `strip_request_headers`, sourced from
`secret_env_var` or an absolute `secret_file`. Release notes for `rust-v0.150.0` list
*"#40466 Add credential brokering to network proxy feature config"*, *"#40484 Broker credential
aliases in child environments"*, *"#40490 Harden project config when credential brokering is
active"*.

**[I]** This is the same idea as `@ai-sdk/harness`'s placeholder splicing, first-party and pointed
**inward** - it keeps a secret out of the *child process environment* Codex's shell tool spawns. It
does **not** keep the model credential out of Codex itself, so it is not an answer to this ticket.
It is directly relevant to ADR 0004's rule that *"any additional secret sandboxed code requires must
be brokered"*, and to [`harness-tool-execution-seam.md`](harness-tool-execution-seam.md)'s finding
that Codex does **not** filter secret-looking environment variables by default. **Worth its own
ticket; out of scope here.**

---

## 10. Empirical status and the tests that remain

### 10.1 The safe test harness

**[V] `CODEX_HOME` fully isolates the CLI from `~/.codex`, and this was confirmed without touching
the real credential.** Two commands were run:

```
CODEX_HOME=<scratch> codex login status
  -> "Not logged in", exit 0, no files created in <scratch>

CODEX_HOME=<scratch> codex doctor --json
  -> checks["auth.credentials"] = {
       status: "fail",
       summary: "no Codex credentials were found",
       details: {"auth file": "<scratch>/auth.json", "auth storage mode": "File"}
     }
```

`~/.codex/auth.json` mtime unchanged throughout (`2026-08-24 19:56:04`). Codex also refuses to create
PATH helper binaries under a temp `CODEX_HOME`, which it announces and then proceeds.

**[V] `codex doctor --json` is documented as "Emit a redacted machine-readable report"** and reports
`auth.credentials` plus which of `openai_api_key` / `codex_api_key` / `codex_access_token` are set.
It is the right instrument for every observation below.

**[I] Therefore T1-T3 can be run with zero risk to `~/.codex`**, provided the operator copies the
access token out read-only and never lets Codex write to the real `CODEX_HOME`.

### 10.2 Tests that need the user's explicit go-ahead

Each is out of bounds for an agent and each is listed with the exact command and the expected
observation. **None of T1-T3 can rotate the refresh token, because none of them supplies one.**

---

**T1 - Does `--with-access-token` reject a Plus/Pro access token, and where?** *(answers §2
empirically; predicted to fail offline)*

```bash
export CODEX_HOME=$(mktemp -d)
jq -r '.tokens.access_token' ~/.codex/auth.json | codex login --with-access-token; echo "exit=$?"
codex login status
ls -la "$CODEX_HOME"
```

*Expected:* non-zero exit with `Error logging in with access token: …`, `codex login status` →
`Not logged in`, and **no `auth.json` created**. Run it with egress blocked (`unshare -n`) to confirm
the rejection is local rather than server-side.
**Risk:** the access token is read but never written or rotated; on the predicted path no network
call is made at all. **Requires the user's explicit go-ahead.**

---

**T2 - Does `CODEX_ACCESS_TOKEN` as an environment variable behave any differently?** *(completes §3)*

```bash
export CODEX_HOME=$(mktemp -d)
CODEX_ACCESS_TOKEN=$(jq -r '.tokens.access_token' ~/.codex/auth.json) codex doctor --json \
  | jq '.checks["auth.credentials"]'
```

*Expected:* the same classifier, the same rejection. **[V]** `load_auth` (`manager.rs:1493-1514`)
uses `classify_codex_access_token` identically and **writes nothing to disk**; **[V]** precedence is
`CODEX_API_KEY` env → ephemeral store → `CODEX_ACCESS_TOKEN` env → persistent store, so
`CODEX_ACCESS_TOKEN` **overrides `~/.codex/auth.json`** but loses to `CODEX_API_KEY`.
**Risk:** none beyond T1. **Requires the user's explicit go-ahead.**

---

**T3 - Does a hand-built refresh-less `chatgpt` `auth.json` run, and how does it fail at expiry?**
*(answers §4.3 and §5.3, and is the only test that would validate the working variant)*

```bash
export CODEX_HOME=$(mktemp -d); chmod 700 "$CODEX_HOME"
jq '{auth_mode: "chatgpt",
     OPENAI_API_KEY: null,
     tokens: {id_token: .tokens.id_token,
              access_token: .tokens.access_token,
              refresh_token: "",
              account_id: .tokens.account_id},
     last_refresh: (now | todate)}' ~/.codex/auth.json > "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
codex doctor --json | jq '.checks["auth.credentials"]'
codex exec -s read-only -a never --skip-git-repo-check "Reply with the single word OK."
```

*Expected:* `auth.credentials` reports configured ChatGPT auth; `codex exec` completes normally.
Then re-run with `last_refresh` backdated past 8 days **and** an access token inside its 5-minute
pre-expiry window, and observe the failure: predicted *"Your access token could not be refreshed.
Please log out and sign in again."*, non-zero exit, **no hang**.
**Risk:** consumes a small amount of the user's plan allowance for one trivial model call. Cannot
rotate anything - `refresh_token` is `""`. **Requires the user's explicit go-ahead.**

---

**T4 - Does an out-of-band refresh invalidate the user's own login?** *(the §6 blocker)*

**Do not run this against the user's account under any circumstances.** The only decisive form is:

```bash
# On a DISPOSABLE ChatGPT account, on a machine whose logout costs nothing:
cp ~/.codex/auth.json /tmp/copy.json          # 1. snapshot
CODEX_HOME=$(mktemp -d) ...                   # 2. refresh using the COPY only
                                              #    POST https://auth.openai.com/oauth/token
                                              #    grant_type=refresh_token
                                              #    client_id=app_EMoamEEZ73f0CkXaXp7hrann
CODEX_HOME=~/.codex codex doctor --json       # 3. can the ORIGINAL still refresh?
```

*Expected:* step 3 fails with `refresh_token_reused` / *"…because your refresh token was already
used."* and the original login is dead.
**Risk: destroys the login it is run against.** **Requires the user's explicit go-ahead, and should
be run only on a disposable account.**

---

**T5 - Does `chatgptAuthTokens` on `codex app-server` work with a Plus/Pro access token?** *(the §9
design lead - the highest-value outstanding test)*

Drive `codex app-server` over stdio, send `account/login` with
`{ access_token, chatgpt_account_id, chatgpt_plan_type }` (account id and plan type are readable from
the token's own claims), then run one thread turn. Observe whether the model request succeeds and
whether the server ever emits the `account/chatgptAuthTokens/refresh` server-request.
**Risk:** consumes a small amount of plan allowance; writes nothing (the credential is `Ephemeral`).
Uses an experimental, undocumented protocol surface.
**Requires the user's explicit go-ahead.**

---

**T6 - Does OpenAI's token endpoint rotate on every refresh, and does it detect reuse?** Only
observable by performing a refresh. Same constraint as T4: **disposable account only.**

---

**T7 - Can a Claude Code `setup-token` be revoked without disturbing the interactive login?**
*(closes the §7.1 hole in ADR 0004's `scoped` definition)*

Mint a setup-token, confirm it appears at `claude.ai/settings/claude-code`, delete it there, then
confirm (a) a `CLAUDE_CODE_OAUTH_TOKEN` run fails and (b) an interactive `claude` session still
works.
**Risk:** mints and revokes a real credential on the user's Anthropic account; does not touch the
interactive login's own grant. **Requires the user's explicit go-ahead.**

---

## 11. Closing verdict, `Exposure`, and what would have to be true

### Does the shape work?

**No, as specified. [V]** `codex login --with-access-token` cannot accept a Plus/Pro-derived access
token - it is an agent-identity/PAT flag, and a ChatGPT user token fails its claim schema, its issuer
and audience pinning, and its JWKS `kid` check.

**A mechanically working variant exists** - the Worker writes a `chatgpt`-mode `auth.json` with
`refresh_token: ""` into the Sandbox's `CODEX_HOME`
([§4.3](#43-a-hand-built-refresh-less-chatgpt-authjson-does-run)), or drives `codex app-server` in
`chatgptAuthTokens` mode ([§9](#9-the-shape-that-does-exist-chatgptauthtokens-on-the-app-server)).
**Both keep the refresh token out of the Sandbox. Neither changes the `Exposure` class.**

### What `Exposure` class would the result earn?

**`account`. Unchanged. [I]**, from three verified facts measured against ADR 0004's definition of
`scoped` as *"a model-only credential revocable without disturbing the user's own login"*:

| `scoped` requires | The best available Codex Plus/Pro credential | Verdict |
| --- | --- | --- |
| model-only | `scp` = `openid profile email offline_access api.connectors.read api.connectors.invoke`; hardcoded, not narrowable **[V]** | fails |
| revocable independently | no per-token revocation exists for a consumer plan; `codex logout` revokes the session (`login/src/auth/revoke.rs`, `token_type_hint`/`client_id` against `auth.openai.com/api/accounts`) **[V]** | fails |
| does not disturb the user's own login | revoking it *is* logging the user out; and any host-side refresh spends a one-time-use refresh token ([§6](#6-q5---does-host-side-refresh-rotate-the-token-in-a-way-that-invalidates-the-users-own-login)) | fails |

It also outlives the Run by up to ten days, which is the plain-language failure of "short-lived."

**ADR 0004 needs no amendment to its decisions.** Its Codex Plus/Pro row (`account`), its dispatch
gate, and its refusal of `account` on `container` all stand. **This ticket confirms the constraint
rather than widening it** - which the ticket itself named as an acceptable outcome.

### Four things ADR 0004 should absorb when it is next edited

None changes a decision; all four are corrections or gaps found on the way.

1. **[I] The Codex Business/Enterprise `scoped` row is not established.** ADR 0004 records
   `CODEX_ACCESS_TOKEN` as *"a short-lived workload token."* [§3](#3-q2---what-does-it-write) shows
   the `--with-access-token` credential is an **Agent Identity JWT carrying `agent_private_key`** -
   bearer-equivalent *signing key material*, with per-request Ed25519 assertions and no bearer token
   on the wire. Whether that is `scoped` depends on how narrowly OpenAI scopes an agent identity and
   how independently it can be revoked, neither of which was established here. **Flagged, not
   resolved; it does not affect the Plus/Pro answer.**
2. **[I] The revocability half of `scoped` is inferred, not documented, for Claude Code**
   ([§7.1](#71-claude-code---the-reduction-is-scope-not-time)). `SECURITY.md` should say revocation is
   user-driven through a Console surface Anthropic does not document, rather than asserting
   revocability as a Reprove property.
3. **[V] OpenCode's row should say what it means**
   ([§7.2](#72-opencode---a-pure-pass-through-so-all-narrowing-is-provider-side)): *a dedicated,
   separately-revocable provider API key supplied as that provider's single models.dev environment
   variable, with no `auth.json` in the Sandbox and no config file containing a literal key.* Add
   that mounting `auth.json` is categorically `account` because `Auth.all()` reads every provider the
   user has ever connected.
4. **[V] "OpenCode has no sandbox at all and says so"** - the second half could not be verified at
   `v1.18.25`. Soften it or re-cite it.

### What would have to remain true for a Codex Native Route Run to be `scoped`?

All four, and none is in Reprove's gift:

1. **OpenAI issues a Codex credential whose scope is model requests only** - no `profile`, no
   `email`, no `api.connectors.*` - for a consumer plan.
2. **That credential is individually revocable** without terminating the user's interactive session.
3. **Its lifetime is bounded near the Run's** - minutes to hours, not ten days.
4. **Deriving it does not consume the user's refresh token.**

Until then the honest statement in `SECURITY.md` and on the product surface is the one ADR 0004
already makes: on the Native Route the credential is inside the boundary, it is an account
credential, and what bounds the risk is Provenance, Isolation and revocability - not separation.

### Outstanding empirical tests

All seven are specified in [§10.2](#102-tests-that-need-the-users-explicit-go-ahead) with exact
commands and expected observations. In priority order: **T1** (confirms §2 cheaply and offline),
**T3** (the only test that would validate the working variant end to end), **T5** (the app-server
lead), **T7** (closes the Claude Code revocation gap), **T2** (completeness), then **T4/T6** - which
**must never be run against the user's own ChatGPT account** and are decisive only on a disposable
one.

---

## Sources

**Codex code**, all at `openai/codex` tag `rust-v0.150.0` (commit `3b3b4f8`):
`codex-rs/cli/src/main.rs`, `cli/src/login.rs`, `cli/src/doctor.rs`,
`login/src/auth/access_token.rs`, `login/src/auth/manager.rs`, `login/src/auth/storage.rs`,
`login/src/auth/agent_identity.rs`, `login/src/auth/revoke.rs`, `login/src/server.rs`,
`login/src/token_data.rs`, `agent-identity/src/lib.rs`, `core/src/client.rs`,
`model-provider/src/auth.rs`, `exec/src/lib.rs`, `app-server/src/external_auth.rs`,
`app-server/src/request_processors/account_processor.rs`, `network-proxy/src/credential_broker.rs`,
and the tests in `login/src/auth/auth_tests.rs`.

**Codex binary**, `@openai/codex-linux-x64` 0.150.0: string extraction confirming the hardcoded OAuth
scope string, the `AuthMode` variants, the refresh-failure messages, the `codex doctor` check
vocabulary, and the app-server `account/chatgptAuthTokens/refresh` server-notification name.

**OpenAI docs**, fetched 2026-08-30:
[learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth),
[.../auth/ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
[.../non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[.../enterprise/access-tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens),
[.../enterprise/service-accounts](https://learn.chatgpt.com/docs/enterprise/service-accounts),
[.../config-file/environment-variables](https://learn.chatgpt.com/docs/config-file/environment-variables),
[.../agent-approvals-security](https://learn.chatgpt.com/docs/agent-approvals-security),
[.../pricing](https://learn.chatgpt.com/docs/pricing),
[.../github-action](https://learn.chatgpt.com/docs/github-action).
Policy pages via Wayback captures of `openai.com/policies/*` (2026-08-20, 2026-08-25) and
`help.openai.com` (2026-03-27), both live-403.

**Anthropic docs**: [Claude Code authentication](https://code.claude.com/docs/en/authentication),
[security](https://code.claude.com/docs/en/security),
[env vars](https://code.claude.com/docs/en/env-vars),
[GitHub Actions](https://code.claude.com/docs/en/github-actions),
[Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart),
[Platform authentication](https://platform.claude.com/docs/en/manage-claude/authentication),
[workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces),
[Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api),
[log out of all sessions](https://support.claude.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions).
Plus the shipped Claude Code 2.1.251 bundle and local `claude --help` / `claude setup-token --help`.

**OpenCode**: [sst/opencode @ `v1.18.25`](https://github.com/sst/opencode)
(`packages/opencode/src/auth/index.ts`, `provider.ts`, `plugin/index.ts`, `plugin/openai/codex.ts`,
`session/llm.ts`, `permission/index.ts`, `control-plane/workspace.ts`, and
`packages/web/src/content/docs/`), the shipped 1.18.25 binary, and
[models.dev/api.json](https://models.dev/api.json).

**Prior Reprove research** this note builds on and, in three places, corrects:
[`harness-tool-execution-seam.md`](harness-tool-execution-seam.md) (#3),
[`provider-auth-and-usage.md`](provider-auth-and-usage.md) (#9),
[ADR 0004](../adr/0004-sandbox-boundary-and-credential-isolation.md).
