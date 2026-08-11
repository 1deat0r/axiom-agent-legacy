#!/usr/bin/env bash
set -euo pipefail

AUTH_FILE="$HOME/.prime/agent/auth.json"
AUTH_BACKUP="$HOME/.prime/agent/auth.json.bak"

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
# PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET makes the self-update paths see a
# live daemon with busy sessions; RLM_* env flips the rlm max-depth default to "env".
# Scrub them so the suite runs against a neutral environment (upstream CI has none).
unset PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET
unset PRIME_AGENT_INTERNAL_DAEMON_WORKER PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN
unset PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID
unset PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL
unset PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL
unset RLM_DEPTH RLM_MAX_DEPTH RLM_SESSION_DIR
unset RLM_GLOBAL_HARNESS_STATE_DIR RLM_HARNESS_STATE_DIR

echo "Running tests without API keys or live-agent env..."
npm test
