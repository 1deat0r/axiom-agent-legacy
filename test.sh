#!/usr/bin/env bash
set -euo pipefail

AUTH_FILE="$HOME/.axiom/agent/auth.json"
AUTH_BACKUP="$HOME/.axiom/agent/auth.json.bak"

# Restore auth.json on exit (success or failure)
cleanup() {
    if [[ -f "$AUTH_BACKUP" ]]; then
        mv "$AUTH_BACKUP" "$AUTH_FILE"
        echo "Restored auth.json"
    fi
}
trap cleanup EXIT

# Move auth.json out of the way
if [[ -f "$AUTH_FILE" ]]; then
    mv "$AUTH_FILE" "$AUTH_BACKUP"
    echo "Moved auth.json to backup"
fi

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY
unset GROQ_API_KEY CEREBRAS_API_KEY XAI_API_KEY OPENROUTER_API_KEY
unset ZAI_API_KEY MISTRAL_API_KEY MINIMAX_API_KEY MINIMAX_CN_API_KEY
unset KIMI_API_KEY HF_TOKEN AI_GATEWAY_API_KEY OPENCODE_API_KEY
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_PROJECT GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE BEDROCK_EXTENSIVE_MODEL_TEST FIREWORKS_API_KEY

# Ambient live-agent env leaks into the suite and changes behavior deterministically:
# AXIOM_INTERNAL_DAEMON_SUPERVISOR_SOCKET makes the self-update paths see a
# live daemon with busy sessions; RLM_* env flips the rlm max-depth default to "env".
# Scrub them so the suite runs against a neutral environment (upstream CI has none).
unset AXIOM_INTERNAL_DAEMON_SUPERVISOR_SOCKET
unset AXIOM_GATEWAY_CHANNEL_ID AXIOM_GATEWAY_SESSION_ID
unset AXIOM_INTERNAL_DAEMON_WORKER AXIOM_INTERNAL_DAEMON_WORKER_TOKEN
unset AXIOM_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID
unset AXIOM_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL
unset AXIOM_INTERNAL_ORPHAN_PROCESS_JOURNAL
unset RLM_DEPTH RLM_MAX_DEPTH RLM_SESSION_DIR
unset RLM_GLOBAL_HARNESS_STATE_DIR RLM_HARNESS_STATE_DIR
# Live gateway credentials/state must never leak into the suite (a set token
# flips "transport selected with no token fails fast", and a set update-repo
# makes resolveGatewayStart's transport-selection assertions drift).
unset AXIOM_TELEGRAM_BOT_TOKEN AXIOM_DISCORD_BOT_TOKEN AXIOM_SLACK_BOT_TOKEN
unset AXIOM_UPDATE_REPO AXIOM_BIN
# An anchored session's project root would activate the root guard, the
# workspace guard, the fence, and the git guard inside unrelated suites whose
# tests touch outside paths — scrub the anchor and the guard config so the
# suite runs neutral without a manual unset.
unset AXIOM_PROJECT_ROOT
unset AXIOM_ROOT_GUARD_ALLOW AXIOM_ROOT_GUARD_DENY AXIOM_ROOT_GUARD_STATE_DIR
unset AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS AXIOM_GIT_GUARD_ALLOW
unset AXIOM_FENCE_ALLOW AXIOM_FENCE_ALLOW_HOSTS

echo "Running tests without API keys or live-agent env..."
npm test
