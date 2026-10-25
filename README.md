# JARVIS · ChatGPT subscription edition

A local voice assistant and Markdown memory graph, adapted from [Itsme23476/jarvis-claude-code](https://github.com/Itsme23476/jarvis-claude-code). The assistant runs through **Codex CLI signed in with ChatGPT**, with `gpt-6-astra` as the default model. There are no canned conversation replies or simulated business actions.

## How authentication works

Every assistant and voice-direction request launches Codex with `forced_login_method="chatgpt"` and the OpenAI provider. API-key environment variables are removed from the child process. Credentials stay in Codex's existing credential store; this app never copies or commits them. This uses your plan's Codex access and usage limits, not OpenAI API billing. Model access depends on your account. See [official authentication documentation](https://learn.chatgpt.com/docs/auth).

Fish Audio is optional and uses its own credentials and billing. It is not included in a ChatGPT subscription.

## Setup

Requirements: Python 3.10+, a current Codex CLI supporting `--ignore-user-config` and `--approve-for-me` (verified with 0.153.3), and a browser. Node.js is only needed for CLI installation and frontend tests.

```sh
npm install -g @openai/codex
codex login
codex login status
```

Choose **Sign in with ChatGPT**. The status must say `Logged in using ChatGPT`.

```sh
git clone https://github.com/Itsme23476/jarvis-chatgpt.git
cd jarvis-chatgpt
cp .env.example .env
chmod 600 .env
./start.sh
```

Open [localhost:8720](http://localhost:8720). To run beside another JARVIS instance, set `JARVIS_PORT=8721` in `.env`. Set `JARVIS_OPEN=0` to prevent automatic browser opening.

You do not need `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`, or Claude Code. A missing or incompatible Codex login is an error; there is no API-key fallback.

## Voice and microphone

Without a Fish key, replies use browser speech synthesis, preferring Daniel in British English when installed. For Fish Audio, privately fill `FISH_AUDIO_API_KEY` and `FISH_AUDIO_VOICE_ID` in `.env`; the default model is `drama-3`. Restart after configuration changes. Keys stay on the local server.

Before Fish playback, a separate, tool-disabled Codex invocation adds delivery directions without rewriting the answer. Tags and the final speech text appear in the action log. A Fish playback failure is shown rather than silently switching voices.

For offline microphone recognition, install [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [FFmpeg](https://ffmpeg.org), obtain a compatible Whisper model, and configure `WHISPER_MODEL`. On macOS, the executables can be installed with `brew install whisper-cpp ffmpeg`. Recognition is fixed to English and assistant replies remain English. If local recognition is unavailable but a Fish key is configured, Fish ASR is used and may incur separate charges. Without either listener, use typed input. Browser speech synthesis does not provide microphone transcription.

Click **Live** once for hands-free input. The listener waits for a pause, sends one turn, and stays quiet while the assistant speaks. Use **Test Fish voice** / **Test Daniel voice** to check the selected output. The page reports actual playback events; hearing the result still depends on your system's audio output.

## Memory and connected apps

The default `vault/` is empty. Add Markdown notes with `[[wiki links]]`, or set `JARVIS_VAULT` to an existing directory. The graph displays real files. Personal vault files, `.env`, and `state.json` are ignored by Git. `python3 seed_vault.py` optionally creates fictional example notes for exploring the graph; these are not live calendar or CRM data.

Slash commands include `/profile`, `/goal`, `/mission`, `/personality`, `/recall`, `/graph`, `/vault`, `/status`, and `/new`. Local profile and task state stays in `state.json`.

Composio integration is optional. Install and authenticate its CLI separately if you want connected services. JARVIS checks existing connections and uses tools for real data; a blank account has no integrations by default. Sending messages and changing records require an explicit request, and completion claims must be backed by successful tool results.

## Local execution and boundaries

The server binds only to `127.0.0.1`. Requests require the random launch token, a valid local Host, and same-origin checks. Do not expose it publicly. Codex uses workspace-write with automatic approval review and outbound network access for connected apps; the voice director is read-only with tools disabled. Choose `JARVIS_WORKDIR` deliberately because it defines the assistant's working directory.

## Validation

```sh
python3 -m unittest discover -p 'test_*.py'
node test_live.js
```

Check `/api/status`, submit an ordinary question, and confirm a real answer. The test suite covers subscription-only invocation, credential stripping, session resumption, voice-plan validation, microphone races, empty vaults, and absence of fixed business replies.

## Attribution

Based on the original repository by [Itsme23476](https://github.com/Itsme23476/jarvis-claude-code). This is a separate repository; setup and publishing do not push changes to the original.
