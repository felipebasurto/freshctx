from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import threading
import queue
import time
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

PROTOCOL = "freshctx/1"
ADAPTER = "freshctx-openhands/openai-completions"
COMPOSE_ORDER = "condense_then_freshctx"
CAPABILITIES = {
    "request_rewrite": True,
    "stable_result_identity": True,
    "projection_insertion": True,
    "shared_workspace": True,
}


def _truthy(value: str | None) -> bool:
    return value in {"1", "true"}


def _falsey(value: str | None) -> bool:
    return value in {"0", "false"}


def config_from_env(env: dict[str, str] | None = None) -> dict[str, Any]:
    source = os.environ if env is None else env
    if _truthy(source.get("FRESHCTX_FALL_OPEN")):
        raise RuntimeError("FreshCtx OpenHands bridge does not support fall-open; rejected plans must cancel dispatch")
    enabled = True if source.get("FRESHCTX_ENABLED") is None else not _falsey(source.get("FRESHCTX_ENABLED"))
    budget = 131072 if source.get("FRESHCTX_BUDGET_BYTES") is None else int(source["FRESHCTX_BUDGET_BYTES"])
    if budget < 0:
        raise RuntimeError("FRESHCTX_BUDGET_BYTES must be a non-negative integer")
    timeout_ms = 10000 if source.get("FRESHCTX_TIMEOUT_MS") is None else int(source["FRESHCTX_TIMEOUT_MS"])
    if timeout_ms < 1:
        raise RuntimeError("FRESHCTX_TIMEOUT_MS must be a positive integer")
    return {
        "enabled": enabled,
        "root": source.get("FRESHCTX_ROOT"),
        "session_id": source.get("FRESHCTX_SESSION_ID"),
        "budget_bytes": budget,
        "timeout_ms": timeout_ms,
        "audit": _truthy(source.get("FRESHCTX_AUDIT")),
        "compose_order": COMPOSE_ORDER,
    }


def revision_for(text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _product_cli() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "bin" / "freshctx.mjs"


def content_text(content: Any) -> str | None:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
        else:
            return None
    return "".join(parts)


def replace_content(content: Any, text: str) -> Any:
    if isinstance(content, str) or content is None:
        return text
    if isinstance(content, list) and len(content) == 1 and isinstance(content[0], dict):
        block = dict(content[0])
        block["type"] = block.get("type") or "text"
        block["text"] = text
        return [block]
    return [{"type": "text", "text": text}]


def as_request(payload: Any) -> dict[str, Any]:
    if isinstance(payload, list):
        return {"messages": payload}
    if isinstance(payload, dict) and isinstance(payload.get("messages"), list):
        return payload
    raise RuntimeError("Expected an OpenHands Chat Completions request with messages")


def index_tool_results(payload: Any) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    request = as_request(payload)
    by_id: dict[str, dict[str, Any]] = {}
    calls: set[str] = set()
    for message in request["messages"]:
        if not isinstance(message, dict):
            raise RuntimeError("Invalid native message")
        if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
            for call in message["tool_calls"]:
                call_id = call.get("id") if isinstance(call, dict) else None
                if not isinstance(call_id, str) or not call_id or call_id in calls:
                    raise RuntimeError("Duplicate or invalid tool call ID")
                calls.add(call_id)
        if message.get("role") != "tool":
            continue
        result_id = message.get("tool_call_id")
        if not isinstance(result_id, str) or result_id in by_id or result_id not in calls:
            raise RuntimeError("Unpaired or duplicate tool result")
        by_id[result_id] = message
    return request, by_id


class Client:
    def __init__(self, root: str, timeout_ms: int = 10000, command: str | None = None, args: list[str] | None = None) -> None:
        node = command or shutil.which("node") or "node"
        argv = args or [str(_product_cli()), "serve", "--stdio", "--root", root]
        self.child = subprocess.Popen(
            [node, *argv],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.timeout_s = timeout_ms / 1000
        self.sequence = 0
        self.lock = threading.Lock()
        self.failure: Exception | None = None
        if self.child.stdin is None or self.child.stdout is None:
            raise RuntimeError("FreshCtx child missing stdio")

    def request(self, op: str, fields: dict[str, Any] | None = None) -> Any:
        deadline = time.monotonic() + self.timeout_s
        if not self.lock.acquire(timeout=self.timeout_s):
            self._fail(RuntimeError("FreshCtx request timed out"))
            raise self.failure
        try:
            if self.failure is not None:
                raise self.failure
            self.sequence += 1
            ident = str(self.sequence)
            payload = {**(fields or {}), "protocol": PROTOCOL, "id": ident, "op": op}
            completed: queue.Queue = queue.Queue(maxsize=1)

            def exchange():
                try:
                    self.child.stdin.write(json.dumps(payload) + "\n")
                    self.child.stdin.flush()
                    line = self.child.stdout.readline()
                    if not line:
                        raise RuntimeError("FreshCtx process exited")
                    reply = json.loads(line)
                    if not isinstance(reply, dict) or reply.get("protocol") != PROTOCOL or not isinstance(reply.get("ok"), bool) or reply.get("id") != ident:
                        raise RuntimeError("Invalid FreshCtx response")
                    completed.put((reply, None))
                except Exception as error:
                    completed.put((None, error))

            worker = threading.Thread(target=exchange, daemon=True)
            worker.start()
            try:
                reply, error = completed.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                self._fail(RuntimeError("FreshCtx request timed out"))
                worker.join(timeout=1)
                raise self.failure
            if error is not None:
                self._fail(RuntimeError(f"FreshCtx transport failed: {error}"))
                raise self.failure
            if self.failure is not None:
                raise self.failure
            if not reply["ok"]:
                error = reply.get("error") or {}
                raise RuntimeError(error.get("message") or "FreshCtx rejected request")
            return reply.get("result")
        finally:
            self.lock.release()

    def _fail(self, error: Exception) -> None:
        if self.failure is None:
            self.failure = error
        if self.child.poll() is None:
            self.child.kill()

    def close(self) -> None:
        self._fail(RuntimeError("FreshCtx client closed"))
        try:
            self.child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait(timeout=1)
        with self.lock:
            if self.child.stdin:
                self.child.stdin.close()
            if self.child.stdout:
                self.child.stdout.close()


class Bridge:
    def __init__(
        self,
        root: str,
        session_id: str,
        budget_bytes: int = 131072,
        enabled: bool = True,
        client: Client | None = None,
        on_audit: Callable[[dict[str, Any]], None] | None = None,
        timeout_ms: int = 10000,
    ) -> None:
        self.root = root
        self.budget_bytes = budget_bytes
        self.enabled = enabled
        self.on_audit = on_audit
        self.client = (client or Client(root, timeout_ms=timeout_ms)) if enabled else None
        if self.client is not None:
            try:
                self.client.request("hello", {
                    "session_id": session_id,
                    "adapter": ADAPTER,
                    "capabilities": CAPABILITIES,
                })
            except Exception:
                self.client.close()
                raise

    def observe(self, result_id: str, path: str, text: str, start_byte: int | None = None, end_byte: int | None = None) -> None:
        if not self.enabled:
            raise RuntimeError("FreshCtx is disabled; do not observe in the without arm")
        fields: dict[str, Any] = {
            "result_id": result_id,
            "path": path,
            "content_utf8_base64": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        }
        if start_byte is not None and end_byte is not None and end_byte > start_byte:
            fields["range"] = {"start_byte": start_byte, "end_byte": end_byte}
        self.client.request("observe", fields)

    def rewrite(self, payload: Any) -> Any:
        request = as_request(payload)
        if not self.enabled:
            copy = json.loads(json.dumps(request))
            self._audit(request, copy, False)
            return copy
        _, by_id = index_tool_results(request)
        plan = self.client.request("prepare", {
            "request_id": str(uuid4()),
            "result_ids": list(by_id),
            "budget_bytes": self.budget_bytes,
        })
        projection_text = base64.b64decode(plan["projection_utf8_base64"]).decode("utf-8")
        if revision_for(projection_text) != plan["projection_sha256"] or len(projection_text.encode("utf-8")) > self.budget_bytes:
            raise RuntimeError("Invalid projection hash or budget")
        replacements: dict[str, str] = {}
        for replacement in plan["replacements"]:
            result = by_id.get(replacement["result_id"])
            text = content_text(result.get("content") if result else None)
            if (
                not isinstance(text, str)
                or revision_for(text) != replacement["expected_sha256"]
                or not isinstance(replacement.get("marker"), str)
                or replacement["result_id"] in replacements
            ):
                raise RuntimeError("Native tool result changed; entire FreshCtx plan discarded")
            replacements[replacement["result_id"]] = replacement["marker"]
        copy = json.loads(json.dumps(request))
        for message in copy["messages"]:
            if message.get("role") == "tool" and message.get("tool_call_id") in replacements:
                message["content"] = replace_content(message.get("content"), replacements[message["tool_call_id"]])
        if projection_text:
            uses_blocks = any(isinstance(message.get("content"), list) for message in copy["messages"])
            copy["messages"].append({
                "role": "user",
                "content": [{"type": "text", "text": projection_text}] if uses_blocks else projection_text,
            })
        committed = self.client.request("commit", {"plan_id": plan["plan_id"]})
        if committed.get("applied") is not True:
            raise RuntimeError("FreshCtx did not commit")
        self._audit(request, copy, True)
        return copy

    def _audit(self, original: dict[str, Any], rewritten: dict[str, Any], enabled: bool) -> None:
        if self.on_audit is None:
            return
        self.on_audit({
            "compose_order": COMPOSE_ORDER,
            "enabled": enabled,
            "projection_inserted": len(rewritten["messages"]) > len(original["messages"]),
        })

    def close(self) -> None:
        if self.client is not None:
            self.client.close()


def wrap_llm(llm: Any, bridge: Bridge) -> Any:
    original = llm.completion

    def completion(messages=None, **kwargs):
        payload = messages if messages is not None else kwargs.get("messages")
        if payload is None and isinstance(kwargs.get("messages"), list):
            payload = kwargs["messages"]
        request = as_request(payload if payload is not None else {"messages": kwargs.get("messages")})
        rewritten = bridge.rewrite(request)
        if messages is not None:
            return original(rewritten["messages"], **kwargs)
        kwargs = {**kwargs, "messages": rewritten["messages"]}
        return original(**kwargs)

    llm.completion = completion
    if hasattr(llm, "async_completion"):
        original_async = llm.async_completion

        async def async_completion(messages=None, **kwargs):
            payload = messages if messages is not None else kwargs.get("messages")
            request = as_request(payload if payload is not None else {"messages": kwargs.get("messages")})
            rewritten = await asyncio.to_thread(bridge.rewrite, request)
            if messages is not None:
                return await original_async(rewritten["messages"], **kwargs)
            kwargs = {**kwargs, "messages": rewritten["messages"]}
            return await original_async(**kwargs)

        llm.async_completion = async_completion
    return llm
