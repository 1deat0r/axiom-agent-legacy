# Provider catalog: official endpoints per vendor, one Claude wire protocol

ADR-0009 records the decision for the /providers expansion: the two built-in
defaults (OpenAI, DeepSeek) become a twelve-entry catalog covering the hosted
LLMs users actually pick between, each configured the vendor's official way.
This ADR documents the chosen strategy and the alternatives weighed.

## Decisions

- **The catalog is a curated list of vendor-official entries.** Each entry
  carries the vendor's official `baseURL` (probe-verified against the live
  API endpoints and docs on 2026-08-11), a current default `model` id (or the
  vendor's own stable alias — `deepseek-chat`, `codex-mini-latest`), and the
  vendor's canonical key env var (`keyEnv` — e.g. `ANTHROPIC_API_KEY`,
  `ZAI_API_KEY`). `AXIOM_API_KEY` remains the legacy fallback for all.
  Entries: openai (gpt-5.6), openai-codex (codex-mini-latest), claude
  (claude-sonnet-5), z-ai (glm-4.6), minimax (MiniMax-M3), moonshot
  (kimi-k2), deepseek (deepseek-chat), openrouter (anthropic/claude-sonnet-5),
  xai (grok-4), gemini (gemini-3.1-pro), groq (llama-3.3-70b-versatile),
  mistral (mistral-large-latest).
- **Key resolution precedence: entry `apiKey` → `keyEnv` env var →
  `AXIOM_API_KEY`** (`keyFor`). A user with `ANTHROPIC_API_KEY` exported can
  pick claude with zero extra setup; `providers.json` can still pin a key to
  an entry (or override any catalog entry by name, unchanged merge semantics).
- **Claude speaks the Anthropic Messages API, not Chat Completions.** A new
  `ClaudeProvider` implements the official wire protocol (`x-api-key` +
  `anthropic-version` headers, `system` field, tool results as merged
  `tool_result` user blocks, `tool_use` content blocks with object `input`,
  required `max_tokens`, the Anthropic SSE event stream). Everything else in
  the catalog uses `OpenAIProvider` — Chat Completions *is* the official
  shape for those vendors. `ProviderEntry.kind` selects the class;
  `createProvider` is the single instantiation seam.
- **`/providers` runs a three-step connect wizard.** Step 1 is a boxed
  menu of providers showing only name + (Connected)/(Not connected), with
  the active provider marked ●. Step 2 offers the auth methods available
  for that provider: reuse the existing connection, enter an API key
  (masked input, persisted to providers.json), or OAuth login — offered
  only when the provider declares a verified device flow. Step 3 lists the
  provider's **live model list, fetched at connect time** (the catalog
  default is marked ●), and picking one persists it and switches. `/use
  <name|n>` still switches directly to the catalog default.
- **OAuth is a generic, tested device flow, enabled per provider.**
  `runDeviceFlow` implements RFC 8628 (device code → URL + code → poll
  with `slow_down`/`access_denied` handling) against per-provider
  endpoints carried on `ProviderEntry.oauth`. A provider is only marked
  OAuth-capable once its endpoints and public client id are probe-verified;
  at time of writing neither OpenAI (Cloudflare-challenges non-browser
  clients) nor Anthropic (internal client UUID) qualified, so the catalog
  offers API keys only — and a `providers.json` entry can declare its own
  `oauth` config to opt a provider in.

## Alternatives considered (and rejected)

- **OpenAI-compat shim for Claude.** Anthropic's Messages API is not
  Chat Completions-shaped; an OpenAI-compat base URL would have saved one
  provider class but dropped tool-result merging semantics, `system`
  extraction and the native stream — "the official way" for Claude is its own
  API, and the LLMProvider interface made adding a second adapter cheap.
- **Only a flat key list (everyone uses AXIOM_API_KEY).** Kept as the legacy
  fallback, but the canonical per-vendor env vars are the ones the vendors
  themselves document; honoring them means a user's existing shell env
  (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, …) works with no export step.
- **Fetching the catalog live (models endpoint per vendor).** Non-deterministic,
  needs keys, and couples the menu to network availability. A reviewed,
  dated static catalog is deterministic and testable; it is a maintenance
  item to refresh (documented in the catalog header comment).
