#!/usr/bin/env python3
"""Neo's persistent JSON-RPC bridge for Hermes Agent (run inside Hermes's own Python runtime).

Isolates stdin/stdout before importing any Hermes or third-party module so no library output or child
process can ever touch the JSONL framing pipe. Supports `--list-models` for listing configured models
and a persistent session mode over newline-delimited JSON on the duplicated stdin/stdout descriptors.
"""

import os
import sys

# Isolate the JSON-RPC pipes before any import can touch stdio or spawn children.
_rpc_in_fd = os.dup(0)
_rpc_out_fd = os.dup(1)
try:
    os.set_inheritable(_rpc_in_fd, False)
    os.set_inheritable(_rpc_out_fd, False)
except (OSError, ValueError, AttributeError):
    pass

_devnull_fd = os.open(os.devnull, os.O_RDONLY)
os.dup2(_devnull_fd, 0)
os.close(_devnull_fd)
os.dup2(2, 1)

_rpc_in = os.fdopen(_rpc_in_fd, "r", encoding="utf-8", errors="replace")
_rpc_out = os.fdopen(_rpc_out_fd, "w", encoding="utf-8", buffering=1)
sys.stdin = open(os.devnull, "r", encoding="utf-8")
sys.stdout = sys.stderr

try:
    import hermes_bootstrap
except ModuleNotFoundError as _exc:
    if _exc.name != "hermes_bootstrap" and not "hermes_bootstrap".startswith(f"{_exc.name}."):
        raise
else:
    if hasattr(hermes_bootstrap, "harden_import_path"):
        hermes_bootstrap.harden_import_path()

import contextlib
import json
import queue
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

_send_lock = threading.Lock()


def emit(frame: dict[str, Any]) -> None:
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _send_lock:
        _rpc_out.write(line)
        _rpc_out.flush()


def _bootstrap_hermes_env() -> Path:
    from hermes_constants import get_hermes_home

    with contextlib.suppress(Exception):
        from hermes_cli._startup_fast import project_root_str

        root = project_root_str()
        if root and root not in sys.path:
            sys.path.insert(0, root)
    with contextlib.suppress(Exception):
        from agent.ssl_verify import install_truststore

        install_truststore()
    home = Path(get_hermes_home())
    with contextlib.suppress(Exception):
        from hermes_cli.env_loader import load_hermes_dotenv

        load_hermes_dotenv(hermes_home=home)
    return home


def list_models_mode() -> int:
    _bootstrap_hermes_env()
    models: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(provider: str, model_id: str, name: str = "") -> None:
        prov = (provider or "").strip()
        mid = (model_id or "").strip()
        if not prov or not mid or (prov, mid) in seen:
            return
        seen.add((prov, mid))
        models.append({"provider": prov, "id": mid, "name": (name or mid).strip()})

    try:
        from hermes_cli.config import load_config
        from hermes_cli.inventory import build_models_payload, load_picker_context
        from hermes_cli.models import normalize_provider

        cfg = load_config() or {}
        ctx = load_picker_context()
        payload = build_models_payload(
            ctx,
            explicit_only=False,
            include_unconfigured=False,
            canonical_order=True,
            pricing=False,
            capabilities=False,
            refresh=False,
            probe_custom_providers=True,
        )
        for row in payload.get("providers") or ():
            raw_slug = str(row.get("slug") or "").strip().lower()
            if not raw_slug:
                continue
            provider = (
                "custom:ollama"
                if raw_slug == "ollama"
                else raw_slug
                if raw_slug.startswith("custom:")
                else normalize_provider(raw_slug)
            )
            label = str(row.get("name") or provider).strip()
            for entry in row.get("models") or ():
                if isinstance(entry, dict):
                    mid = str(entry.get("id") or entry.get("model") or entry.get("name") or "").strip()
                    mname = str(entry.get("name") or mid).strip()
                else:
                    mid = str(entry or "").strip()
                    mname = mid
                if mid:
                    display = f"{label} · {mname}" if label and label.lower() != provider.lower() else mname
                    add(provider, mid, display)

        with contextlib.suppress(Exception):
            from acp_adapter.model_catalog import _named_custom_provider_catalogs

            for slug, label, catalog in _named_custom_provider_catalogs():
                for mid, _desc in catalog:
                    add(slug, mid, f"{label} · {mid}" if label else mid)

        model_cfg = cfg.get("model")
        if isinstance(model_cfg, dict):
            cfg_prov = str(model_cfg.get("provider") or "").strip()
            cfg_default = str(model_cfg.get("default") or model_cfg.get("name") or "").strip()
            if cfg_prov and cfg_default:
                norm = cfg_prov if cfg_prov.startswith("custom:") else normalize_provider(cfg_prov)
                add(norm, cfg_default, cfg_default)
    except Exception as exc:
        emit({"type": "error", "error": f"Hermes could not list its models: {exc}"})
        return 1

    models.sort(key=lambda item: (item["provider"], item["id"]))
    emit({"type": "models", "models": models})
    return 0


def _allowed_builtin_tools(kinds: list[str], with_memory: bool) -> tuple[list[str], set[str]]:
    toolsets: list[str] = []
    allowed: set[str] = set()

    def want_ts(name: str) -> None:
        if name not in toolsets:
            toolsets.append(name)

    for kind in kinds:
        if kind == "read":
            want_ts("file")
            allowed.update(("read_file", "search_files"))
        elif kind == "edit":
            want_ts("file")
            allowed.add("patch")
        elif kind == "write":
            want_ts("file")
            allowed.add("write_file")
        elif kind == "bash":
            want_ts("terminal")
            want_ts("web")
            want_ts("code_execution")
            allowed.update(("terminal", "process_manage", "web_search", "web_extract", "execute_code"))
        elif kind == "task":
            want_ts("delegation")
            allowed.add("delegate_task")

    if with_memory:
        for extra_ts in ("skills", "memory", "session_search", "todo"):
            want_ts(extra_ts)
        allowed.update(("skills_list", "skill_view", "skill_manage", "memory", "session_search", "todo_list"))
        if "bash" in kinds:
            want_ts("vision")
            want_ts("browser")
            allowed.update(("vision_analyze", "browser_exec", "browser_cdp", "browser_dialog", "browser_vault"))

    return toolsets, allowed


_NEO_API_MODES = {
    "openai-completions": "chat_completions",
    "openai-responses": "codex_responses",
    "anthropic-messages": "anthropic_messages",
}


def _neo_provider(name: str | None) -> dict[str, Any] | None:
    """The custom provider of a name that Neo hands over in NEO_PROVIDERS, if any."""
    if not name:
        return None
    with contextlib.suppress(Exception):
        for provider in json.loads(os.environ.get("NEO_PROVIDERS") or "[]"):
            if isinstance(provider, dict) and provider.get("name") == name:
                return provider
    return None


def _split_model(raw: str | None) -> tuple[str | None, str | None]:
    text = (raw or "").strip()
    if not text:
        return None, None
    if "/" in text:
        prov, model_id = text.split("/", 1)
        return prov.strip() or None, model_id.strip() or None
    return None, text


def _reasoning_config_for(config: dict[str, Any], model_id: str, thinking: str | None) -> dict[str, Any] | None:
    level = (thinking or "").strip().lower()
    if level == "off":
        return {"effort": "none", "enabled": False}
    if level in {"minimal", "low", "medium", "high", "xhigh", "max"}:
        return {"effort": level, "enabled": True}
    with contextlib.suppress(Exception):
        from hermes_constants import resolve_reasoning_config

        return resolve_reasoning_config(config, model_id)
    return None


def _blocks_to_user_content(blocks: list[dict[str, Any]]) -> tuple[str, Any, bool]:
    texts: list[str] = []
    parts: list[dict[str, Any]] = []
    has_image = False
    for block in blocks:
        kind = block.get("type")
        if kind == "text":
            text = str(block.get("text") or "")
            if text:
                texts.append(text)
                parts.append({"type": "text", "text": text})
        elif kind == "image":
            mime = str(block.get("mimeType") or "image/png")
            data = str(block.get("data") or "")
            if data:
                has_image = True
                parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
    joined = "\n\n".join(texts)
    if not has_image:
        return joined, joined, True
    if not any(p.get("type") == "text" for p in parts):
        parts.insert(0, {"type": "text", "text": "[Attached image]"})
    return joined or "[Attached image]", parts, False


class SessionBridge:
    def __init__(self, init_frame: dict[str, Any]) -> None:
        self.home = _bootstrap_hermes_env()
        self.cwd = str(init_frame.get("cwd") or os.getcwd())
        os.makedirs(self.cwd, exist_ok=True)
        os.chdir(self.cwd)

        os.environ["HERMES_YOLO_MODE"] = "1"
        os.environ["HERMES_QUIET"] = "1"

        self.system_prompt = str(init_frame.get("system_prompt") or "")
        self.builtin_kinds = [str(x) for x in (init_frame.get("builtin_tools") or [])]
        self.host_tools = list(init_frame.get("host_tools") or [])
        self.host_tool_names = {str(t.get("name")) for t in self.host_tools if t.get("name")}
        self.persist = bool(init_frame.get("persist", True))
        self.context_files = bool(init_frame.get("context_files", False))
        self.memory = bool(init_frame.get("memory", False))
        self.background_review = bool(init_frame.get("background_review", False))
        self.max_turns = init_frame.get("max_turns")
        self.model_spec: str | None = init_frame.get("model")
        self.thinking: str | None = init_frame.get("thinking")

        self.toolsets, self.allowed_builtins = _allowed_builtin_tools(self.builtin_kinds, self.memory)
        if self.host_tool_names:
            self.toolsets.append("neo")
        self.allowed_all = self.allowed_builtins | self.host_tool_names

        self._waiters_lock = threading.Lock()
        self._waiters: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self._state_lock = threading.Lock()
        self._turn_running = False
        self._pending_submissions: list[tuple[str, list[dict[str, Any]]]] = []
        self._acknowledged_jobs: set[str] = set()
        self._work_queue: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._closed = threading.Event()
        self._model_dirty = False

        self.persistence = None
        self.db = None
        self.history: list[dict[str, Any]] = []
        resume_id = str(init_frame.get("resume") or "").strip() or None
        self.session_id = resume_id or str(uuid.uuid4())

        self._setup_hooks_and_tools()
        self._init_persistence(resume_id)
        self.agent = self._build_agent()

    def _ask_host(self, frame: dict[str, Any], timeout: float = 600.0) -> dict[str, Any]:
        call_id = str(uuid.uuid4())
        evt = threading.Event()
        holder: dict[str, Any] = {}
        with self._waiters_lock:
            self._waiters[call_id] = (evt, holder)
        try:
            emit({**frame, "call_id": call_id})
            if not evt.wait(timeout=timeout):
                return {"timeout": True}
            return holder
        finally:
            with self._waiters_lock:
                self._waiters.pop(call_id, None)

    def resolve_waiter(self, call_id: str, frame: dict[str, Any]) -> None:
        with self._waiters_lock:
            entry = self._waiters.get(call_id)
        if entry is not None:
            evt, holder = entry
            holder.update(frame)
            evt.set()

    def _setup_hooks_and_tools(self) -> None:
        from tools.registry import discover_builtin_tools, registry

        discover_builtin_tools()

        for spec in self.host_tools:
            name = str(spec.get("name") or "").strip()
            if not name:
                continue
            description = str(spec.get("description") or "")
            parameters = spec.get("schema") if isinstance(spec.get("schema"), dict) else {"type": "object", "properties": {}}

            def _make_handler(tool_name: str):
                def _handler(args: dict[str, Any], **_kw: Any) -> str:
                    ans = self._ask_host({
                        "type": "tool_call",
                        "name": tool_name,
                        "arguments": args if isinstance(args, dict) else {},
                    })
                    if ans.get("timeout"):
                        return json.dumps({"error": f"Host tool {tool_name} timed out"})
                    if ans.get("ok"):
                        res = ans.get("result")
                        return res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)
                    return json.dumps({"error": str(ans.get("error") or "Host tool error")}, ensure_ascii=False)

                return _handler

            registry.register(
                name=name,
                toolset="neo",
                schema={"name": name, "description": description, "parameters": parameters},
                handler=_make_handler(name),
                description=description,
                override=True,
            )

        from hermes_cli import plugins as _plugins
        from hermes_cli.plugins import PluginContext, PluginManifest, discover_plugins, get_plugin_manager

        # Disable the 30s plugin callback timeout so long guard checks never fail-close prematurely.
        _plugins._resolve_hook_callback_timeout = lambda: 0.0
        discover_plugins()
        mgr = get_plugin_manager()
        ctx = PluginContext(PluginManifest(name="neo-kernel", version="1.0.0", description="Neo kernel guard"), mgr)

        def _guard_hook(tool_name: str = "", args: Any = None, **_kw: Any) -> dict[str, Any] | None:
            if tool_name not in self.allowed_all:
                reason = f"Tool '{tool_name}' is not available in this session"
                emit({"type": "tool_result_msg", "text": reason[:2000]})
                return {"action": "block", "message": reason}
            payload = args if isinstance(args, dict) else {}
            ans = self._ask_host({"type": "guard", "tool": tool_name, "input": payload})
            if ans.get("timeout"):
                reason = "Tool guard timed out"
                emit({"type": "tool_result_msg", "text": reason})
                return {"action": "block", "message": reason}
            if not ans.get("allow", False):
                reason = str(ans.get("reason") or "Blocked by host guard")
                emit({"type": "tool_result_msg", "text": reason[:2000]})
                return {"action": "block", "message": reason}
            return None

        def _retry_hook(**_kw: Any) -> None:
            emit({"type": "retry"})

        ctx.register_hook("pre_tool_call", _guard_hook)
        ctx.register_hook("api_request_error", _retry_hook)

        with contextlib.suppress(Exception):
            from agent import turn_context

            # Neo owns Ticket titles; skip Hermes's background sidebar auto-titling LLM request.
            turn_context._maybe_title_session_at_turn_start = lambda *_a, **_kw: None

        with contextlib.suppress(Exception):
            from tools import terminal_tool

            terminal_tool.set_approval_callback(lambda *_a, **_kw: "once")
            terminal_tool.register_task_env_overrides(self.session_id, {"cwd": self.cwd})

    def _init_persistence(self, resume_id: str | None) -> None:
        if not self.persist:
            return
        try:
            from persistence.conversation.messages import ConversationRequest
            from persistence_assembly import open_persistence, profile_scope

            self.db = open_persistence(profile_scope(home=self.home), eager=True)
            self.persistence = self.db
            if resume_id:
                row = self.persistence.sessions.get(resume_id)
                if row is not None:
                    if getattr(row, "ended_at", None) is not None:
                        with contextlib.suppress(Exception):
                            self.persistence.sessions.reopen(resume_id)
                    self.history = [
                        msg.as_openai_message()
                        for msg in self.persistence.messages.read_conversation(
                            resume_id, ConversationRequest(repair_alternation=True)
                        )
                    ]
        except Exception:
            self.db = None
            self.persistence = None

    def _build_agent(self) -> Any:
        from hermes_cli.config import load_config
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from run_agent import AIAgent

        config = load_config() or {}
        model_cfg = config.get("model")
        default_model, config_provider = "", None
        if isinstance(model_cfg, dict):
            default_model = str(model_cfg.get("default") or model_cfg.get("name") or "").strip()
            config_provider = model_cfg.get("provider")
        elif isinstance(model_cfg, str):
            default_model = model_cfg.strip()

        req_provider, req_model = _split_model(self.model_spec)
        target_model = req_model or default_model
        requested = req_provider or config_provider

        kwargs: dict[str, Any] = {
            "platform": "cli",
            "quiet_mode": True,
            "session_id": self.session_id,
            "session_db": self.db if self.persist else None,
            "persistence": self.persistence if self.persist else None,
            "enabled_toolsets": list(self.toolsets),
            "model": target_model,
            "cwd": self.cwd,
            "ephemeral_system_prompt": self.system_prompt or None,
            "skip_context_files": not self.context_files,
            "load_soul_identity": False,
            "skip_memory": not self.memory,
            "skip_background_review": not self.background_review,
            "reasoning_config": _reasoning_config_for(config, target_model, self.thinking),
        }
        if isinstance(self.max_turns, int) and self.max_turns > 0:
            kwargs["max_iterations"] = self.max_turns

        custom = _neo_provider(req_provider)
        if custom is not None:
            # A custom provider Neo hands over: its endpoint and key as given, past Hermes's own provider ladder.
            kwargs.update({
                "provider": "custom",
                "api_mode": _NEO_API_MODES.get(str(custom.get("api") or ""), "chat_completions"),
                "base_url": str(custom.get("baseUrl") or ""),
                "api_key": os.environ.get(str(custom.get("apiKeyEnv") or ""), "") or "neo-no-key",
            })
        else:
            with contextlib.suppress(Exception):
                runtime = resolve_runtime_provider(requested=requested, target_model=target_model or None)
                kwargs.update({
                    "provider": runtime.get("provider"),
                    "api_mode": runtime.get("api_mode"),
                    "base_url": runtime.get("base_url"),
                    "api_key": runtime.get("api_key"),
                    "credential_pool": runtime.get("credential_pool"),
                    "command": runtime.get("command"),
                    "args": list(runtime.get("args") or []),
                })
                if runtime.get("request_overrides"):
                    kwargs["request_overrides"] = runtime["request_overrides"]

        agent = AIAgent(**kwargs)
        agent._print_fn = lambda *a, **kw: print(*a, **{**kw, "file": sys.stderr})
        agent._auto_recovery_cycles = 0
        if not self.persist:
            agent._persist_disabled = True

        from tools.registry import registry

        # Build the Session's exact allowed tool schemas directly from the registry so Neo's host tools
        # and allowed built-in tools are never deferred behind Hermes's interactive `tool_search` catalog.
        filtered = registry.get_definitions(set(self.allowed_all), quiet=True)
        agent.tools = filtered
        agent.valid_tool_names = {tool["function"]["name"] for tool in filtered}
        if callable(inv := getattr(agent, "_invalidate_system_prompt", None)):
            inv()

        def _on_interim(text: str, *_a: Any, **_kw: Any) -> None:
            cleaned = (text or "").strip()
            if cleaned:
                emit({"type": "assistant", "content": [{"type": "text", "text": cleaned}], "stop_reason": "toolUse"})

        def _on_tool_start(call_id: str, name: str, args: Any, *_a: Any, **_kw: Any) -> None:
            parsed = args if isinstance(args, dict) else {}
            if isinstance(args, str):
                with contextlib.suppress(Exception):
                    loaded = json.loads(args)
                    if isinstance(loaded, dict):
                        parsed = loaded
            emit({
                "type": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": str(call_id or uuid.uuid4()),
                    "name": str(name or ""),
                    "arguments": parsed,
                }],
                "stop_reason": "toolUse",
            })

        def _on_tool_complete(_call_id: str, _name: str, _args: Any, result: Any, *_a: Any, **_kw: Any) -> None:
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            emit({"type": "tool_result_msg", "text": text[:2000]})

        agent.interim_assistant_callback = _on_interim
        agent.tool_start_callback = _on_tool_start
        agent.tool_complete_callback = _on_tool_complete
        return agent

    def _owner_ids(self) -> set[str]:
        ids = {self.session_id}
        cur = getattr(self.agent, "session_id", None)
        if cur:
            ids.add(str(cur))
        task = getattr(self.agent, "_current_task_id", None)
        if task:
            ids.add(str(task))
        return ids

    def _awaiting_async(self) -> bool:
        try:
            from tools.process_registry import process_registry

            owners = self._owner_ids()
            with process_registry._lock:
                for s in process_registry._running.values():
                    if s.id in self._acknowledged_jobs:
                        continue
                    if (not s.owner_task_id or s.owner_task_id in owners) and not s.exited:
                        if s.notify_on_complete or (s.watch_patterns and not s._watch_disabled):
                            return True
            with process_registry.completion_queue.mutex:
                for evt in process_registry.completion_queue.queue:
                    if isinstance(evt, dict):
                        sid = str(evt.get("session_id") or "")
                        if sid and sid not in self._acknowledged_jobs:
                            owner = str(evt.get("owner_task_id") or "")
                            if not owner or owner in owners:
                                return True
        except Exception:
            pass
        with contextlib.suppress(Exception):
            from tools.delegate_tool_registry import _active_subagents, _active_subagents_lock

            with _active_subagents_lock:
                if _active_subagents:
                    return True
        return False

    def list_jobs(self) -> list[dict[str, Any]]:
        jobs: list[dict[str, Any]] = []
        with contextlib.suppress(Exception):
            from tools.process_registry import process_registry

            owners = self._owner_ids()
            with process_registry._lock:
                running = list(process_registry._running.values())
            for s in running:
                if s.exited:
                    continue
                if s.owner_task_id and s.owner_task_id not in owners and not s.owner_task_id.startswith("sa-"):
                    continue
                pids = [int(s.pid)] if isinstance(s.pid, int) and s.pid > 0 else []
                jobs.append({
                    "id": str(s.id),
                    "kind": "bash",
                    "label": str(s.command or s.id),
                    "startTime": int((s.started_at or time.time()) * 1000),
                    "progress": None,
                    "command": str(s.command) if s.command else None,
                    "own": not str(s.owner_task_id or "").startswith("sa-"),
                    "pids": pids,
                })
        with contextlib.suppress(Exception):
            from tools.delegate_tool_registry import _active_subagents, _active_subagents_lock

            with _active_subagents_lock:
                items = list(_active_subagents.items())
            for sid, rec in items:
                label = str(rec.get("goal") or rec.get("task") or sid)
                started = rec.get("started_at") or time.time()
                jobs.append({
                    "id": str(sid),
                    "kind": "task",
                    "label": label,
                    "startTime": int(float(started) * 1000),
                    "progress": None,
                    "command": None,
                    "own": True,
                    "pids": [],
                })
        return jobs

    def ack_jobs(self, ids: list[str]) -> None:
        self._acknowledged_jobs.update(ids)
        with contextlib.suppress(Exception):
            from tools.process_registry import process_registry

            with process_registry._lock:
                for jid in ids:
                    process_registry._completion_consumed.add(jid)
                    sess = process_registry._running.get(jid) or process_registry._finished.get(jid)
                    if sess is not None:
                        sess.notify_on_complete = False
                        sess._watch_disabled = True

    def cancel_job(self, job_id: str) -> bool:
        self.ack_jobs([job_id])
        with contextlib.suppress(Exception):
            from tools.process_registry import process_registry

            if process_registry.get(job_id) is not None:
                res = process_registry.kill_process(job_id, consume_output=True)
                return "error" not in res or res.get("status") in {"killed", "already_exited"}
        with contextlib.suppress(Exception):
            from tools.delegate_tool_registry import _active_subagents, _active_subagents_lock, interrupt_subagent

            with _active_subagents_lock:
                known = job_id in _active_subagents
            if known:
                interrupt_subagent(job_id)
                return True
        return False

    def _run_one_turn(self, user_text: str, user_content: Any) -> None:
        if self._model_dirty:
            self._model_dirty = False
            self.agent = self._build_agent()

        from gateway.session_context import clear_session_vars, set_session_vars
        from tools.approval_context import reset_hermes_interactive_context, set_hermes_interactive_context

        tokens = set_session_vars(
            session_key=self.session_id,
            session_id=self.session_id,
            cwd=self.cwd,
            cron_session="",
        )
        interactive_tok = set_hermes_interactive_context(False)
        old_sid = os.environ.get("HERMES_SESSION_ID")
        os.environ["HERMES_SESSION_ID"] = self.session_id
        try:
            result = self.agent.run_conversation(
                user_message=user_content,
                conversation_history=self.history,
                task_id=self.session_id,
                persist_user_message=user_text or "[Attached image]",
            )
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            result = {"failed": True, "error": str(exc), "messages": self.history}
        finally:
            if old_sid is None:
                os.environ.pop("HERMES_SESSION_ID", None)
            else:
                os.environ["HERMES_SESSION_ID"] = old_sid
            reset_hermes_interactive_context(interactive_tok)
            clear_session_vars(tokens)

        if isinstance(result.get("messages"), list):
            self.history = result["messages"]

        final_text = str(result.get("final_response") or "").strip()
        if result.get("failed"):
            err_text = str(result.get("error") or final_text or "Hermes model request failed").strip()
            emit({"type": "assistant", "content": [{"type": "text", "text": err_text}], "stop_reason": "error"})
        elif result.get("interrupted"):
            msg = final_text or "Interrupted"
            emit({"type": "assistant", "content": [{"type": "text", "text": msg}], "stop_reason": "aborted"})
        elif final_text:
            emit({"type": "assistant", "content": [{"type": "text", "text": final_text}], "stop_reason": "stop"})

    def _turn_worker_loop(self) -> None:
        while not self._closed.is_set():
            item = self._work_queue.get()
            if item is None or self._closed.is_set():
                return

            if item["kind"] == "wake":
                with self._state_lock:
                    if self._turn_running or self._pending_submissions:
                        continue
                    self._turn_running = True
                emit({"type": "running"})
                self._run_one_turn(item["text"], item["text"])
            else:
                with self._state_lock:
                    batch = list(self._pending_submissions)
                    self._pending_submissions.clear()
                    if not batch:
                        continue
                    self._turn_running = True
                emit({"type": "running"})
                blocks: list[dict[str, Any]] = []
                for sub_id, sub_blocks in batch:
                    emit({"type": "taken", "id": sub_id})
                    blocks.extend(sub_blocks)
                user_text, user_content, _ = _blocks_to_user_content(blocks)
                self._run_one_turn(user_text, user_content)

            while True:
                with self._state_lock:
                    if not self._pending_submissions:
                        self._turn_running = False
                        break
                    batch = list(self._pending_submissions)
                    self._pending_submissions.clear()
                blocks = []
                for sub_id, sub_blocks in batch:
                    emit({"type": "taken", "id": sub_id})
                    blocks.extend(sub_blocks)
                user_text, user_content, _ = _blocks_to_user_content(blocks)
                self._run_one_turn(user_text, user_content)

            emit({"type": "idle", "awaiting_async": self._awaiting_async()})

    def _completion_watcher_loop(self) -> None:
        try:
            from tools.process_registry import process_registry
            from tools.process_registry_notifications import format_completion_notification
        except Exception:
            return

        while not self._closed.is_set():
            try:
                evt = process_registry.completion_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            except Exception:
                continue

            if not isinstance(evt, dict):
                continue
            sid = str(evt.get("session_id") or "")
            if sid in self._acknowledged_jobs or process_registry.is_completion_consumed(sid):
                continue
            owner = str(evt.get("owner_task_id") or "")
            if owner and owner not in self._owner_ids():
                continue

            try:
                text = format_completion_notification(evt)
            except Exception:
                code = evt.get("exit_code")
                cmd = evt.get("command") or sid
                out = str(evt.get("output") or "")[-2000:]
                text = f"[Background process {sid} ({cmd}) finished with exit code {code}]\n{out}"
            if text and text.strip():
                self._work_queue.put({"kind": "wake", "text": text.strip()})

    def handle_submit(self, frame: dict[str, Any]) -> None:
        sub_id = str(frame.get("id") or "")
        deliver = str(frame.get("deliver") or "follow_up")
        content = list(frame.get("content") or [])
        user_text, _user_content, text_only = _blocks_to_user_content(content)

        with self._state_lock:
            if self._turn_running and deliver == "steer" and text_only and user_text:
                if hasattr(self.agent, "redirect") and getattr(self.agent, "_supports_active_turn_redirect", False):
                    with contextlib.suppress(Exception):
                        if self.agent.redirect(user_text):
                            emit({"type": "taken", "id": sub_id})
                            return
            self._pending_submissions.append((sub_id, content))
            need_wake = not self._turn_running
        if need_wake:
            self._work_queue.put({"kind": "submit"})

    def interrupt(self) -> None:
        with contextlib.suppress(Exception):
            from agent.interrupt_compat import request_hard_interrupt

            request_hard_interrupt(self.agent)

    def set_model(self, model: str | None, thinking: str | None) -> None:
        self.model_spec = model
        self.thinking = thinking
        self._model_dirty = True

    def close(self) -> None:
        self._closed.set()
        self.interrupt()
        self._work_queue.put(None)
        if self.persistence is not None:
            with contextlib.suppress(Exception):
                self.persistence.sessions.end(self.session_id, "neo_session_close")

    def serve(self) -> int:
        emit({"type": "ready", "session_id": self.session_id})
        threading.Thread(target=self._turn_worker_loop, name="neo-hermes-turn", daemon=True).start()
        threading.Thread(target=self._completion_watcher_loop, name="neo-hermes-bg", daemon=True).start()

        for raw in _rpc_in:
            line = raw.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            kind = frame.get("type")
            if kind == "submit":
                self.handle_submit(frame)
            elif kind in {"guard_result", "tool_result"}:
                call_id = str(frame.get("call_id") or "")
                if call_id:
                    self.resolve_waiter(call_id, frame)
            elif kind == "interrupt":
                self.interrupt()
            elif kind == "jobs":
                emit({"type": "response", "req_id": frame.get("req_id"), "jobs": self.list_jobs()})
            elif kind == "ack":
                ids = [str(x) for x in (frame.get("ids") or [])]
                self.ack_jobs(ids)
                emit({"type": "response", "req_id": frame.get("req_id"), "ok": True})
            elif kind == "cancel":
                cancelled = self.cancel_job(str(frame.get("job") or ""))
                emit({"type": "response", "req_id": frame.get("req_id"), "cancelled": cancelled})
            elif kind == "set_model":
                self.set_model(frame.get("model"), frame.get("thinking"))
                emit({"type": "response", "req_id": frame.get("req_id"), "ok": True})
            elif kind == "close":
                self.close()
                break

        self.close()
        return 0


def main() -> int:
    if sys.argv[1:] == ["--list-models"]:
        return list_models_mode()

    first = _rpc_in.readline()
    if not first:
        return 0
    try:
        init_frame = json.loads(first)
        if not isinstance(init_frame, dict) or init_frame.get("type") != "init":
            emit({"type": "error", "error": "Expected init frame"})
            return 2
        bridge = SessionBridge(init_frame)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": f"Hermes startup failed: {exc}"})
        return 1
    return bridge.serve()


if __name__ == "__main__":
    sys.exit(main())
