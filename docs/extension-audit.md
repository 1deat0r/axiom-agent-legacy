# Extension audit: the four pi-extension workspaces

Audited 2026-08-14 against `main` = 473516062 (branch `feat/extension-audit`).
ADR-0063 records the decision.

## What the four packages are

The four `pi-extension-*` packages are npm workspaces nested under
`packages/coding-agent/examples/extensions/` and listed in the root
`package.json` `workspaces` array. One correction to the issue text: they
are under `packages/` — one level below the top-level `packages/*` glob,
which is why a top-level scan misses them. The `pi-extension-` npm names
are upstream axiom branding (the `pi` CLI era), not pi-fork leftovers: the
dirs were introduced by upstream axiom commits — unified extensions system
(c6fc08453), sandbox extension (4751ebddb), provider-example rename
(758baa9fe) — and exist on the `upstream-pi/main` lineage too. They are not
pi-fork ports and do not belong in the `docs/ports.md` queue.

| Workspace | Directory | What it does |
|---|---|---|
| `pi-extension-with-deps` | `with-deps/` | Minimal example: registers a `parse_duration` tool on the `ms` package to prove the loader resolves an extension's own dependency context |
| `pi-extension-sandbox` | `sandbox/` | OS-level bash sandboxing (bubblewrap / sandbox-exec) via `@anthropic-ai/sandbox-runtime`; replaces the built-in bash tool, adds `--no-sandbox` flag, `/sandbox` command, merged JSON config |
| `pi-extension-custom-provider-anthropic` | `custom-provider-anthropic/` | Worked `registerProvider` example: hand-rolled `streamSimple` for the Anthropic API, PKCE OAuth `/login`, env API key, two models, plus a Claude-Code stealth OAuth mode |
| `pi-extension-custom-provider-gitlab-duo` | `custom-provider-gitlab-duo/` | Worked `registerProvider` example: delegates to built-in `streamSimpleAnthropic` / `streamSimpleOpenAIResponses` through GitLab's AI Gateway proxy; GitLab OAuth; six models; manual live `test.ts` |

## Evidence shared by all four

### The extension seam they ride is intact

- The loader still honors the `pi.extensions` package.json manifest
  (`readPiManifest` / `resolveExtensionEntries` in
  `packages/coding-agent/src/core/extensions/loader.ts`), so the `-e <dir>`
  convention in each package's header is the real load path today.
- The root `tsconfig.json` includes `packages/coding-agent/examples/**/*`
  and maps `@earendil-works/pi-*` to source. `tsgo --noEmit` exits 0 on
  this branch, so all four packages typecheck against the current API.
- Every value import they make exists and is exported today:
  `createBashTool`, `BashOperations`, `getAgentDir`
  (pi-coding-agent `src/index.ts`); `streamSimpleAnthropic`,
  `streamSimpleOpenAIResponses`, `createAssistantMessageEventStream`,
  `calculateCost`, `registerApiProvider` (pi-ai via
  `providers/register-builtins.ts`, `utils/event-stream.ts`,
  `api-registry.ts`); `ProviderConfig` accepts `baseUrl` / `apiKey` /
  `api` / `models` / `oauth` / `streamSimple`
  (`core/model-registry.ts`). `registerFlag`, `registerCommand`,
  `registerTool`, `getFlag`, `on("session_start")`, `on("user_bash")`,
  and the `ctx.ui.notify` / `setStatus` / `theme` surface all still exist.
- Typecheck and runtime bind differently. The loader aliases
  `@earendil-works/pi-*` to `packages/*/dist/index.js`
  (`getAliases` in loader.ts, node_modules fallback), so a loaded example
  runs against the built dist while `tsgo` checks it against source. A
  stale dist can drift from what the typecheck proved — the known repo
  hazard applies to these examples exactly as to the CLI.
- Workspace hoisting supplies the dependencies: `ms`,
  `@anthropic-ai/sdk`, and `@anthropic-ai/sandbox-runtime` are all present
  in the root `node_modules` (`sandbox-runtime` is also a root
  devDependency). None of the four dirs has its own `node_modules` on
  disk; the with-deps header's "npm install in this directory" note is
  historical and unnecessary under workspace hoisting.

### Import graph

Grep for each package name and each directory path over `packages/`
(excluding the example dirs themselves and docs) returns exactly one hit:
`packages/coding-agent/test/extensions-discovery.test.ts:302` loads
`with-deps` as a live fixture. No live code imports any of the four.

### Docs value

All four are documented: `examples/extensions/README.md` rows,
`docs/extensions.md` example table (rows 2568-2589), `custom-provider.md`
"Example Extensions" links the two provider examples, and ADR-0014 names
the sandbox example as pi's confinement substrate.

## Per package

### 1. `pi-extension-with-deps` — keep (already wired in as a fixture)

**Purpose.** Minimal example registering the `parse_duration` tool on the
`ms` package; its whole point is proving the loader resolves an
extension's own dependency context.

**Importers.** `test/extensions-discovery.test.ts` ("resolves dependencies
from extension's own node_modules") loads this exact directory through
`discoverAndLoadExtensions` and asserts the tool registers. The suite is
green (27/27 in this worktree).

**Wire-in cost.** Zero — it is already the canonical fixture for exactly
the property it demonstrates.

**Archive cost.** Removes a live test fixture (the suite must be reworked),
removes a workspace entry plus the root `package-lock.json` entries (lock
regeneration), and breaks the README and extensions.md rows. The cost
exceeds any gain.

**Recommendation.** Keep.

### 2. `pi-extension-sandbox` — keep (wire-in is a security-policy decision, not plumbing)

**Purpose.** OS-level bash sandboxing (bubblewrap on Linux, sandbox-exec
on macOS) via `@anthropic-ai/sandbox-runtime`. It replaces the built-in
bash tool with sandboxed `BashOperations`, adds a `--no-sandbox` flag, a
`/sandbox` command, and merged JSON config (global
`~/.axiom/agent/extensions/sandbox.json`, project
`.axiom/agent/sandbox.json`) with a network allowlist and filesystem
deny/allow rules.

**Importers.** None in-repo.

**Wire-in cost.** Medium, and mostly not code. The seam works
(`createBashTool` + `BashOperations`, `registerFlag`, `session_start`,
`ctx.ui` all typecheck), but enabling it needs Linux system dependencies
(bubblewrap, socat, ripgrep, per its header), config plumbing, and
accepting that every bash call becomes sandbox-mediated. It also overlaps
the existing security fence (ADR-0028) and git-guard (ADR-0049): wiring it
in is choosing an additional confinement posture, not filling a gap.

**Archive cost.** Low-medium: workspace plus lock entries, README and
extensions.md rows, and ADR-0014's confinement-substrate sentence loses
its referent.

**Recommendation.** Keep. Do not wire in without operator sign-off.

### 3. `pi-extension-custom-provider-anthropic` — keep (reference example; do not wire in)

**Purpose.** Worked example of `registerProvider`: a second
`custom-anthropic` provider with a hand-rolled `streamSimple` (Anthropic
Messages streaming events mapped to `AssistantMessageEventStream`), PKCE
OAuth `/login`, env-key auth, two model definitions, and a Claude-Code
stealth OAuth mode (spoofed user-agent).

**Importers.** None in-repo.

**Wire-in cost.** Low mechanically, near-zero value. pi-ai already ships
the built-in anthropic provider with OAuth
(`utils/oauth/anthropic.ts` `anthropicOAuthProvider`), and the built-in
provider already sends the claude-code/oauth beta headers. The unique
content is educational (the hand-rolled stream) and the stealth mode,
which is terms-of-service gray.

**Archive cost.** Low-medium: workspace plus lock entries, README and
extensions.md rows, and `custom-provider.md`'s example links.

**Recommendation.** Keep as reference. Do not wire in.

### 4. `pi-extension-custom-provider-gitlab-duo` — keep (optional wire-in candidate behind a flag)

**Purpose.** Worked example of `registerProvider` delegating to the
built-in `streamSimpleAnthropic` / `streamSimpleOpenAIResponses` through
GitLab's AI Gateway proxy endpoints, with GitLab OAuth, a direct-access
token cache, and six model definitions. `test.ts` is a manual live script
that needs `/login gitlab-duo` credentials.

**Importers.** None in-repo. Fragility: `test.ts` imports from
`packages/coding-agent/src/config.js`, a repo-root-relative path import
that only resolves from the monorepo root via the tsconfig paths mapping.

**Wire-in cost.** Low-to-medium. Additive (no built-in GitLab provider to
conflict with), but it depends on internal GitLab endpoints
(`/api/v4/ai/third_party_agents/direct_access`) that can change without
notice, and live verification needs GitLab Duo credentials
(operator-gated).

**Archive cost.** Low-medium: same doc-link and lockfile surface as the
other provider example.

**Recommendation.** Keep. Wire in behind a config flag only if a GitLab
Duo operator wants it and can verify it live.

## Dead-package test: none dead, no archive commit

The issue's archive criterion is zero importers AND zero docs value.
`with-deps` has a test importer; all four have docs value. No archive
commit is prepared on this branch. If the operator still wants fewer
workspaces, each archive costs: workspace entry removal plus
`package-lock.json` regeneration (a build-config touch that requires the
full test floor per the issue's verification plan), plus the doc-link
fixes listed per package above.

## Verification

- Import graph: grep for the four package names and directory paths over
  the repo; the single non-doc hit is the with-deps test fixture.
- `tsgo --noEmit` exit 0 on the branch (the root include covers
  `packages/coding-agent/examples/**/*`).
- `test/extensions-discovery.test.ts` 27/27 (vitest), including the
  with-deps live-load fixture.
- No live-code changes; this branch is documentation only.
