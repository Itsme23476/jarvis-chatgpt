"""Codex CLI runtime using the user's ChatGPT subscription, never API keys."""
import collections
import json
import os
import queue
import shlex
import shutil
import subprocess
import threading
import time
import uuid

MODEL = os.environ.get("JARVIS_MODEL", "gpt-6-astra").strip() or "gpt-6-astra"
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
PERMISSION = "workspace-write / automatic approval review"
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "180"))
EXECUTION_LOCK = threading.RLock()
_ACTIVE_PROC = None
_ACTIVE_LOCK = threading.Lock()


def subscription_env():
    env = dict(os.environ)
    for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "FISH_AUDIO_API_KEY"):
        env.pop(name, None)
    return env


def _codex_base():
    configured = os.environ.get("CODEX_CMD", "").strip()
    return shlex.split(configured) if configured else [shutil.which("codex") or "codex"]


def _can_launch():
    try:
        p = subprocess.run(_codex_base() + ["--version"], cwd=WORKDIR,
                           capture_output=True, text=True, timeout=15,
                           env=subscription_env())
        return p.returncode == 0, (p.stdout or p.stderr).strip()
    except Exception as e:
        return False, str(e)


def runtime_kind():
    return "codex" if _can_launch()[0] else "unavailable"


def version():
    ok, detail = _can_launch()
    return detail if ok else "unavailable"


def valid_session(sid):
    try:
        return bool(sid) and str(uuid.UUID(str(sid))) == str(sid).lower()
    except (ValueError, AttributeError, TypeError):
        return False


def cancel_active():
    with _ACTIVE_LOCK:
        proc = _ACTIVE_PROC
    if proc is None or proc.poll() is not None:
        return False
    proc.terminate()
    return True


def build_command(message, session_id=None, system=None, speech_schema=None):
    # Standard subscription routing, independent of custom API-provider config.
    # Authentication stays in the existing Codex credential store.
    cmd = _codex_base() + [
        "exec", "--ignore-user-config", "--json", "--model", MODEL,
        "--skip-git-repo-check",
        "-c", 'forced_login_method="chatgpt"',
        "-c", 'model_provider="openai"',
        "-c", 'model_reasoning_effort="low"',
    ]
    if speech_schema:
        cmd += ["--ephemeral", "--sandbox", "read-only", "--output-schema", str(speech_schema),
                "-c", 'approval_policy="never"']
        for feature in ("shell_tool", "unified_exec", "apps", "plugins", "browser_use",
                        "browser_use_external", "computer_use", "multi_agent", "view_image"):
            cmd += ["--disable", feature]
        session_id = None
    else:
        # Composio's installed CLI reuses the user's existing account connections.
        # Allow outbound requests while retaining filesystem sandboxing/review.
        cmd += ["--approve-for-me", "-c", "sandbox_workspace_write.network_access=true"]
    if system:
        cmd += ["-c", "developer_instructions=" + json.dumps(system)]
    if valid_session(session_id):
        cmd += ["resume", str(session_id)]
    return cmd + ["--", message]


class Events:
    """Translate Codex JSONL events without inventing successful responses."""
    def __init__(self, session_id=None):
        self.session_id = session_id
        self.started = time.monotonic()
        self.text_seen = False
        self.terminal = False
        self.emitted_items = set()

    def map(self, ev):
        kind = ev.get("type")
        if kind == "thread.started":
            sid = ev.get("thread_id")
            if valid_session(sid):
                self.session_id = sid
            yield dict(t="status", model=MODEL, runtime="codex",
                       session_id=self.session_id, permission=PERMISSION)
        elif kind in ("item.started", "item.completed"):
            item = ev.get("item") or {}
            item_type = item.get("type")
            if item_type == "agent_message" and kind == "item.completed":
                text = item.get("text") or ""
                item_id = item.get("id")
                if text and (item_id is None or item_id not in self.emitted_items):
                    if not self.text_seen:
                        yield dict(t="latency", ms=int((time.monotonic() - self.started) * 1000))
                    if item_id is not None:
                        self.emitted_items.add(item_id)
                    self.text_seen = True
                    yield dict(t="delta", text=text)
            elif item_type in ("command_execution", "mcp_tool_call", "web_search", "file_change"):
                detail = item.get("command") or item.get("query") or item.get("tool") or ""
                yield dict(t="tool", phase="use" if kind == "item.started" else "result",
                           name=item.get("tool") or item_type,
                           input=" ".join(str(detail).split())[:90],
                           ok=item.get("status") != "failed" and item.get("exit_code", 0) in (0, None))
        elif kind == "turn.completed":
            usage = ev.get("usage") or {}
            incoming, outgoing = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
            yield dict(t="usage", input_tokens=incoming, output_tokens=outgoing,
                       total_tokens=incoming + outgoing)
            self.terminal = True
            if not self.text_seen:
                yield dict(t="error", message="Codex completed without a spoken answer.")
            else:
                yield dict(t="complete", session_id=self.session_id,
                           ms=int((time.monotonic() - self.started) * 1000))
        elif kind in ("turn.failed", "error"):
            error = ev.get("error") or ev.get("message") or "Codex request failed"
            if isinstance(error, dict):
                error = error.get("message") or str(error)
            self.terminal = True
            yield dict(t="error", message=str(error)[:500])


def _run_locked(message, session_id=None, system=None, speech_schema=None):
    global _ACTIVE_PROC
    proc = subprocess.Popen(build_command(message, session_id, system, speech_schema), cwd=WORKDIR,
                            text=True, bufsize=1, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=subscription_env())
    with _ACTIVE_LOCK:
        _ACTIVE_PROC = proc
    lines = queue.Queue()
    errors = collections.deque(maxlen=8)

    def pump_out():
        try:
            for line in proc.stdout:
                lines.put(line)
        finally:
            lines.put(None)

    def pump_err():
        for line in proc.stderr:
            errors.append(line.rstrip())

    out_thread = threading.Thread(target=pump_out, daemon=True)
    err_thread = threading.Thread(target=pump_err, daemon=True)
    out_thread.start()
    err_thread.start()
    events = Events(session_id)
    last = time.monotonic()
    try:
        while True:
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                if time.monotonic() - last > IDLE_TIMEOUT:
                    yield dict(t="error", message=f"Codex went quiet for {IDLE_TIMEOUT}s and was stopped.")
                    return
                continue
            if line is None:
                break
            last = time.monotonic()
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            yield from events.map(event)
            if events.terminal:
                # Let Codex finish persisting the session before it is resumed.
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                return
        rc = proc.wait(timeout=5)
        err_thread.join(timeout=1)
        yield dict(t="error", message=(" | ".join(errors) or
                   f"Codex exited ({rc}) without completing the turn.")[-500:])
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        out_thread.join(timeout=1)
        err_thread.join(timeout=1)
        proc.stdout.close()
        proc.stderr.close()
        with _ACTIVE_LOCK:
            if _ACTIVE_PROC is proc:
                _ACTIVE_PROC = None


def run(message, session_id=None, system=None, speech_schema=None):
    try:
        with EXECUTION_LOCK:
            yield from _run_locked(message, session_id, system, speech_schema)
    except Exception as e:
        yield dict(t="error", message=f"Could not run Codex: {e}")
