# Setup instructions for an AI coding assistant

Set up this repository as a real JARVIS assistant using the operator's ChatGPT subscription through Codex CLI.

1. Read README.md and `.env.example`. Use Python 3.10+ and Codex CLI. Check `codex --version` and `codex login status`; if not signed in with ChatGPT, help the operator complete `codex login` themselves. Do not inspect or print credential files.
2. Copy `.env.example` to an ignored `.env` if absent; preserve an existing file and set its permissions to 600. Keep `gpt-6-astra` unless the operator chooses another available model. Never set or request OpenAI or Anthropic API keys. Do not invoke Claude, use `--bare`, add an API fallback, or bypass Codex's review/sandbox controls.
3. Voice is optional. Ask for a Fish key only if the operator requests Fish Audio; use a private entry method and never print it. Ask for a voice selection. Otherwise use the browser voice. Fish billing is separate from ChatGPT.
4. For microphone input, configure whisper.cpp, a compatible model, and ffmpeg. Prefer offline transcription. Explain any fallback to separately billed Fish ASR. Keep English recognition and replies.
5. Start `./start.sh`, keeping the bind address at 127.0.0.1. Preserve Host/Origin/token checks. Use a different configured port if another app occupies 8720; do not terminate unrelated servers.
6. Verify `/api/status` and a real `/api/run` response. Run the Python and JavaScript tests. If voice is enabled, verify audio generation and playback; do not claim it was heard based only on an HTTP response.
7. Keep personal notes, profile state, keys, logs, recordings, and auth material out of Git. There are no scripted business-response overrides. Never invent sent messages, leads found, or calendar bookings.
8. Preserve original-repository attribution. Push only to the destination repository explicitly chosen by the operator.
