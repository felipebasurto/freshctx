"""FreshCtx bridge for Mini-SWE-Agent (bash-only tool calls).

The agent reads files with shell commands in a sandbox it reaches through a
host-side environment. This bridge keeps a host mirror of only the files it has
observed, observes an allowlisted shell read when its output equals the mirror
exactly, and rewrites the outgoing copy of each model request: observed read
outputs become FreshCtx markers inside their observation messages, and the
projection of current code is appended. The saved trajectory is unchanged.

Modes: ``off`` (no FreshCtx), ``shadow`` (observe and prepare for coverage
logging, dispatch the native request), ``rewrite`` (dispatch the rewritten
copy). ``notice=True`` appends a one-time change notice with a unified diff to
the request after each applied intervention, in the outgoing copy only.
"""

from __future__ import annotations

import base64
import copy
import difflib
import hashlib
import json
import re
import shlex
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "openhands"))
from freshctx_openhands import CAPABILITIES, Client, revision_for  # noqa: E402  (shared Python JSONL client)

ADAPTER = "freshctx-mini-swe-agent/openai-completions"
DEFAULT_BUDGET_BYTES = 131072
MAX_OUTPUT_CHARS = 10000  # mini.yaml elides outputs of 10,000 characters or more
MODES = ("off", "shadow", "rewrite")
NOTICE_TEMPLATE = "[Note: {path} was changed outside this session after your earlier work. The change:\n```diff\n{diff}```]"


class FreshCtxBlocked(RuntimeError):
    """The rewrite could not be verified; the request must not be dispatched."""


# ---------------------------------------------------------------- shell reads

@dataclass(frozen=True)
class ShellRead:
    path: str
    cwd: str | None
    start: int  # one-based first line
    end: int | None  # one-based last line, inclusive; None means to the end
    numbered: bool
    whole: bool
    tail: int | None = None  # tail -n N: the last N lines

    def select(self, lines: list[str]) -> tuple[int, list[str]]:
        """Return (index of the first selected line, selected lines), as the command prints them."""
        if self.tail is not None:
            first = max(0, len(lines) - self.tail) if self.tail else len(lines)
            return first, lines[first:]
        first = self.start - 1
        last = len(lines) if self.end is None else max(self.end, self.start)
        return first, lines[first:last]


_RANGE = re.compile(r"^(\d+)(?:,(\d+))?p$")
_SAFE_PATH = re.compile(r"^[A-Za-z0-9_./@+-][A-Za-z0-9_./@+,=-]*$")


def _path_ok(token: str) -> bool:
    return bool(_SAFE_PATH.match(token)) and not token.startswith("-")


def _positive(token: str) -> int | None:
    return int(token) if token.isdigit() and int(token) > 0 else None


def _sed_range(token: str) -> tuple[int, int] | None:
    match = _RANGE.match(token)
    if not match:
        return None
    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else start
    return (start, end) if start > 0 and end > 0 else None


def parse_shell_read(command: str) -> ShellRead | None:
    """Recognise one allowlisted read with no side effects, optionally after `cd DIR &&`.

    Allowlist: ``cat F``, ``cat -n F``, ``nl -ba F``, ``sed -n 'A,Bp' F``,
    ``nl -ba F | sed -n 'A,Bp'``, ``head -n N F``, ``tail -n N F``.
    """
    if not isinstance(command, str) or "\n" in command.strip() or any(ch in command for ch in "`$*?[]{}~<>;!\\"):
        return None
    try:
        lexer = shlex.shlex(command.strip(), posix=True, punctuation_chars="|&;<>()")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return None
    cwd = None
    if len(tokens) >= 3 and tokens[0] == "cd" and tokens[2] == "&&":
        if not _path_ok(tokens[1]):
            return None
        cwd, tokens = tokens[1], tokens[3:]
    if any(token in {"&&", "||", ";", "&", "(", ")", "<", ">", ">>"} for token in tokens):
        return None
    n = len(tokens)
    if n == 2 and tokens[0] == "cat" and _path_ok(tokens[1]):
        return ShellRead(tokens[1], cwd, 1, None, numbered=False, whole=True)
    if n == 3 and tokens[:2] in (["cat", "-n"], ["nl", "-ba"]) and _path_ok(tokens[2]):
        return ShellRead(tokens[2], cwd, 1, None, numbered=True, whole=True)
    if n == 4 and tokens[:2] == ["sed", "-n"] and _path_ok(tokens[3]) and _sed_range(tokens[2]):
        start, end = _sed_range(tokens[2])
        return ShellRead(tokens[3], cwd, start, end, numbered=False, whole=False)
    if n == 7 and tokens[:2] == ["nl", "-ba"] and tokens[3:6] == ["|", "sed", "-n"] and _path_ok(tokens[2]) and _sed_range(tokens[6]):
        start, end = _sed_range(tokens[6])
        return ShellRead(tokens[2], cwd, start, end, numbered=True, whole=False)
    if n == 4 and tokens[:2] == ["head", "-n"] and _path_ok(tokens[3]) and _positive(tokens[2]):
        return ShellRead(tokens[3], cwd, 1, _positive(tokens[2]), numbered=False, whole=False)
    if n == 4 and tokens[:2] == ["tail", "-n"] and _path_ok(tokens[3]) and _positive(tokens[2]):
        return ShellRead(tokens[3], cwd, 1, None, numbered=False, whole=False, tail=_positive(tokens[2]))
    return None


def split_lines(text: str) -> list[str]:
    return text.splitlines(keepends=True) if text else []


def render_read(read: ShellRead, text: str) -> tuple[str, int, str]:
    """What the command prints for this file text, plus the selected raw span.

    Returns (expected output, start offset in characters, raw selected text).
    Numbered views use GNU ``cat -n`` / ``nl -ba`` format: ``%6d\\t``.
    """
    lines = split_lines(text)
    first, selected = read.select(lines)
    raw = "".join(selected)
    if read.numbered:
        output = "".join(f"{first + index + 1:6d}\t{line}" for index, line in enumerate(selected))
    else:
        output = raw
    return output, len("".join(lines[:first])), raw


def output_matches(expected: str, actual: str) -> bool:
    """Exact match; the only tolerance is a newline some tools add after a last line that lacks one."""
    return actual == expected or (not expected.endswith("\n") and actual == expected + "\n")


# ---------------------------------------------------------------- diffs

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_patch(diff: str) -> dict[str, list[dict[str, Any]]]:
    """Per-file hunks of a unified (git) diff: {path: [{old_start, new_start, old: [...], new: [...]}]}."""
    files: dict[str, list[dict[str, Any]]] = {}
    current = None
    hunk = None
    last = ""
    for line in diff.splitlines(keepends=True):
        if line.startswith("+++ "):
            name = line[4:].rstrip("\n").split("\t")[0]
            current = files.setdefault(name[2:] if name.startswith("b/") else name, [])
            hunk = None
        elif line.startswith(("--- ", "diff --git", "index ")):
            hunk = None
        elif (match := _HUNK.match(line)) and current is not None:
            hunk = {"old_start": int(match.group(1)), "new_start": int(match.group(3)), "old": [], "new": []}
            current.append(hunk)
        elif hunk is not None and line[:1] in {" ", "-", "+"}:
            body, last = line[1:], line[0]
            if last in " -":
                hunk["old"].append(body)
            if last in " +":
                hunk["new"].append(body)
        elif hunk is not None and line.startswith("\\"):  # "\ No newline at end of file"
            for side, kinds in (("old", " -"), ("new", " +")):
                if last in kinds and hunk[side]:
                    hunk[side][-1] = hunk[side][-1].rstrip("\n")
    return files


def reverse_apply(after: str, hunks: list[dict[str, Any]]) -> str | None:
    """Rebuild the text before a patch from the text after it; None if any hunk does not match exactly once."""
    lines = split_lines(after)
    edits = []
    for hunk in hunks:
        new = hunk["new"]
        at = hunk["new_start"] - 1 if new else hunk["new_start"]
        if not (0 <= at <= len(lines) and lines[at:at + len(new)] == new):
            matches = [index for index in range(len(lines) - len(new) + 1) if lines[index:index + len(new)] == new] if new else []
            if len(matches) != 1:
                return None
            at = matches[0]
        edits.append((at, len(new), hunk["old"]))
    for at, length, old in sorted(edits, reverse=True):
        lines[at:at + length] = old
    return "".join(lines)


def unified(path: str, before: str, after: str) -> str:
    return "".join(difflib.unified_diff(split_lines(before), split_lines(after), f"a/{path}", f"b/{path}", n=3))


def changed_spans(before: str, after: str) -> list[tuple[int, int]]:
    """Byte spans in `after` that differ from `before`; a pure deletion marks the line at the deletion point."""
    old, new = split_lines(before), split_lines(after)
    offsets = [0]
    for line in new:
        offsets.append(offsets[-1] + len(line.encode("utf-8")))
    spans = []
    for tag, _, _, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        if j2 == j1:  # deletion: the neighbouring line stands for it
            j1, j2 = (j1 - 1, j1) if j1 == len(new) and j1 > 0 else (j1, min(j1 + 1, len(new)))
        if j2 > j1:
            spans.append((offsets[j1], offsets[j2]))
    return spans


def covered(spans: list[tuple[int, int]], units: list[tuple[int, int]]) -> str:
    """'full' if every span lies in the union of units, 'partial' if some byte does, else 'none'."""
    if not spans:
        return "none"
    merged: list[list[int]] = []
    for start, end in sorted(units):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    inside = [any(start <= s and e <= end for start, end in merged) for s, e in spans]
    touched = [any(s < end and start < e for start, end in merged) for s, e in spans]
    return "full" if all(inside) else "partial" if any(touched) else "none"


# ---------------------------------------------------------------- bridge

@dataclass
class Observed:
    result_id: str
    path: str
    command: str
    output: str
    returncode: Any
    exception_info: str
    content_sha256: str
    rendered_sha256: str


def _sha(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _fetch_script(paths: list[str]) -> str:
    """Print `path<TAB>ok<TAB>base64` or `path<TAB>missing` for each repository-relative path."""
    quoted = " ".join(shlex.quote(path) for path in paths)
    return (
        f"for f in {quoted}; do if [ -f \"$f\" ] && [ ! -L \"$f\" ]; then "
        "printf '%s\\tok\\t' \"$f\"; base64 < \"$f\" | tr -d '\\n'; printf '\\n'; "
        "else printf '%s\\tmissing\\n' \"$f\"; fi; done"
    )


class MiniBridge:
    """Observe shell reads and rewrite outgoing requests for one Mini-SWE-Agent run.

    ``internal_exec(command, cwd) -> (stdout, returncode)`` runs a command in the
    sandbox without counting as an agent command. ``render(output) -> str``
    renders an observation exactly as the agent will (the model's observation
    template with the agent's template variables).
    """

    def __init__(
        self,
        *,
        mirror_root: str | Path,
        repo_root: str,
        internal_exec: Callable[[str, str | None], tuple[str, int]],
        mode: str = "rewrite",
        notice: bool = False,
        session_id: str | None = None,
        budget_bytes: int = DEFAULT_BUDGET_BYTES,
        max_output_chars: int = MAX_OUTPUT_CHARS,
        log_path: str | Path | None = None,
        client: Client | None = None,
    ) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        self.mode = mode
        self.notice = notice
        self.mirror = Path(mirror_root)
        self.mirror.mkdir(parents=True, exist_ok=True)
        self.repo_root = repo_root.rstrip("/") or "/"
        self.internal_exec = internal_exec
        self.budget_bytes = budget_bytes
        self.max_output_chars = max_output_chars
        self.log_path = Path(log_path) if log_path else None
        self.render: Callable[[dict[str, Any]], str] | None = None
        self.observed: dict[str, Observed] = {}
        self.paths: set[str] = set()
        self.pending_notices: list[str] = []
        self.pending_coverage: list[dict[str, Any]] = []
        self.commands = 0
        self.requests = 0
        self._canonical_root: str | None = None
        self.client = None
        if mode != "off":
            self.client = client or Client(str(self.mirror))
            self.client.request("hello", {
                "session_id": session_id or str(uuid4()),
                "adapter": ADAPTER,
                "capabilities": CAPABILITIES,
            })

    # -- logging

    def log(self, event: str, **fields: Any) -> None:
        if self.log_path is None:
            return
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": event, "time": time.time(), **fields}, ensure_ascii=False) + "\n")

    # -- sandbox access

    def canonical_root(self) -> str:
        if self._canonical_root is None:
            stdout, code = self.internal_exec(f"cd {shlex.quote(self.repo_root)} && pwd -P", None)
            if code != 0 or not stdout.strip():
                raise FreshCtxBlocked("cannot resolve the repository root in the sandbox")
            self._canonical_root = stdout.strip().splitlines()[-1]
        return self._canonical_root

    def snapshot(self, path: str, cwd: str | None) -> tuple[str | None, bytes | None, str]:
        """Resolve `path` as the agent's shell would and read it: (repository path, bytes, reason)."""
        root = self.canonical_root().rstrip("/")
        quoted = shlex.quote(path)
        script = (
            f"cd {shlex.quote(cwd or self.repo_root)} && cd \"$(dirname -- {quoted})\" && "
            f"f=\"$(pwd -P)/$(basename -- {quoted})\" && printf '%s\\n' \"$f\" && "
            "if [ -f \"$f\" ] && [ ! -L \"$f\" ]; then printf 'ok\\t'; base64 < \"$f\" | tr -d '\\n'; printf '\\n'; else printf 'missing\\n'; fi"
        )
        stdout, code = self.internal_exec(script, None)
        lines = stdout.split("\n")
        if code != 0 or len(lines) < 2:
            return None, None, "unresolved"
        full = lines[0]
        if not full.startswith(root + "/"):
            return None, None, "outside_repository"
        relative = full[len(root) + 1:]
        if not lines[1].startswith("ok\t"):
            return relative, None, "missing"
        return relative, base64.b64decode(lines[1][3:]), ""

    def fetch(self, paths: list[str]) -> dict[str, bytes | None]:
        if not paths:
            return {}
        stdout, code = self.internal_exec(_fetch_script(paths), self.canonical_root())
        if code != 0:
            raise FreshCtxBlocked("mirror refresh failed in the sandbox")
        found: dict[str, bytes | None] = {}
        for line in stdout.splitlines():
            parts = line.split("\t")
            if len(parts) == 3 and parts[1] == "ok":
                found[parts[0]] = base64.b64decode(parts[2])
            elif len(parts) == 2 and parts[1] == "missing":
                found[parts[0]] = None
        if set(found) != set(paths):
            raise FreshCtxBlocked("mirror refresh returned an incomplete listing")
        return found

    def write_mirror(self, found: dict[str, bytes | None]) -> None:
        for path, data in found.items():
            target = self.mirror / path
            if data is None:
                target.unlink(missing_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.read_bytes() != data:
                target.write_bytes(data)

    def refresh(self) -> None:
        self.write_mirror(self.fetch(sorted(self.paths)))

    # -- environment hook

    def execute(self, action: dict[str, Any], run: Callable[[dict[str, Any]], dict[str, Any]], drain: Callable[[], list[dict[str, Any]]] | None = None) -> dict[str, Any]:
        """Run one agent action through `run`, observing it if it is an allowlisted read."""
        self.commands += 1
        index = self.commands
        command = action.get("command", "")
        read = parse_shell_read(command) if self.mode != "off" else None
        snapshot = path = None
        reason = ""
        if read is not None:
            try:
                path, snapshot, reason = self.snapshot(read.path, read.cwd)
            except FreshCtxBlocked as error:
                reason = f"snapshot_failed:{error}"
            if snapshot is not None:
                self.write_mirror({path: snapshot})  # the file exactly as the read will see it
        try:
            result = run(action)
        finally:
            events = drain() if drain else []
            if events:
                self.on_interventions(events, command_index=index)
        if read is not None and reason:
            self.log("command", index=index, status="skipped", reason=reason, path=path)
        elif read is not None:
            self.log("command", index=index, **self._observe(action, read, path, snapshot, result))
        else:
            self.log("command", index=index, status="not_read")
        return result

    def _observe(self, action: dict[str, Any], read: ShellRead, path: str | None, snapshot: bytes | None, result: dict[str, Any]) -> dict[str, Any]:
        detail: dict[str, Any] = {"path": path, "read": {"start": read.start, "end": read.end, "tail": read.tail, "numbered": read.numbered, "whole": read.whole}}
        result_id = action.get("tool_call_id")
        output = result.get("output", "")
        if not isinstance(result_id, str) or not result_id:
            return {**detail, "status": "skipped", "reason": "no_tool_call_id"}
        if result.get("returncode") != 0 or result.get("exception_info"):
            return {**detail, "status": "skipped", "reason": "failed"}
        if len(output) >= self.max_output_chars:
            return {**detail, "status": "skipped", "reason": "truncated"}
        try:
            text = snapshot.decode("utf-8")
        except UnicodeDecodeError:
            return {**detail, "status": "skipped", "reason": "non_utf8"}
        expected, start_chars, raw = render_read(read, text)
        if not output_matches(expected, output):
            return {**detail, "status": "skipped", "reason": "mismatch"}
        rendered = self.render({"output": output, "returncode": result.get("returncode"), "exception_info": result.get("exception_info", "")}) if self.render else None
        if rendered is None or not any(form in rendered for form in (output, json.dumps(output), _tojson(output))):
            return {**detail, "status": "skipped", "reason": "not_rendered_in_full"}
        content = raw if read.whole else (raw.rstrip("\r\n") or raw)
        if not content:
            return {**detail, "status": "skipped", "reason": "empty"}
        fields: dict[str, Any] = {
            "result_id": result_id,
            "path": path,
            "content_utf8_base64": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        }
        if not read.whole:
            start = len(text[:start_chars].encode("utf-8"))
            fields["range"] = {"start_byte": start, "end_byte": start + len(content.encode("utf-8"))}
        try:
            reply = self.client.request("observe", fields)
        except RuntimeError as error:
            return {**detail, "status": "skipped", "reason": f"engine:{error}"}
        self.observed[result_id] = Observed(
            result_id, path, action.get("command", ""), output, result.get("returncode"),
            result.get("exception_info", ""), revision_for(content), _sha(rendered),
        )
        self.paths.add(path)
        return {**detail, "status": "observed", "result_id": result_id, "unit_id": reply.get("unit_id"),
                "bytes": len(content.encode("utf-8"))}

    # -- interventions

    def on_interventions(self, events: list[dict[str, Any]], *, command_index: int) -> None:
        for event in events:
            if not event.get("patch_applied"):
                self.log("intervention", command_index=command_index, applied=False, scenario_id=event.get("scenario_id"))
                continue
            files = parse_patch(event.get("patch_diff") or "")
            found = self.fetch(sorted(files)) if files else {}
            notes = []
            for path, hunks in sorted(files.items()):
                after_bytes = found.get(path)
                after = after_bytes.decode("utf-8", errors="replace") if after_bytes is not None else ""
                before = reverse_apply(after, hunks)
                source = "reverse_applied"
                if before is None:
                    before, source = None, "patch_diff"
                diff = unified(path, before, after) if before is not None else _normalized_patch(event["patch_diff"], path)
                notes.append(NOTICE_TEMPLATE.format(path=path, diff=diff))
                spans = changed_spans(before, after) if before is not None else []
                self.pending_coverage.append({
                    "intervention_index": event.get("intervention_index"),
                    "scenario_id": event.get("scenario_id"),
                    "path": path,
                    "spans": spans,
                    "observed_path_before": path in self.paths,
                    "command_index": command_index,
                    "notice_source": source,
                })
            if self.notice and notes:
                self.pending_notices.append("\n\n".join(notes))
            self.log("intervention", command_index=command_index, applied=True, scenario_id=event.get("scenario_id"),
                     intervention_index=event.get("intervention_index"), files=sorted(files))

    # -- model hook

    def outgoing(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The copy of `messages` to dispatch. Raises FreshCtxBlocked when a rewrite cannot be verified."""
        self.requests += 1
        notices, self.pending_notices = self.pending_notices, []
        entry: dict[str, Any] = {"request": self.requests, "mode": self.mode, "notices": len(notices)}
        outgoing = messages
        if self.mode != "off" and self.observed:
            try:
                rewritten, plan_entry = self._rewrite(messages)
                entry.update(plan_entry)
                if self.mode == "rewrite":
                    outgoing = rewritten
            except FreshCtxBlocked as error:
                entry["blocked"] = str(error)
                if self.mode == "rewrite":
                    self.log("request", **entry, rewritten=False)
                    raise
        self._flush_uncovered()
        if notices:
            outgoing = outgoing if outgoing is not messages else copy.deepcopy(messages)
            outgoing.extend({"role": "user", "content": note} for note in notices)
        self.log("request", **entry, rewritten=outgoing is not messages and self.mode == "rewrite")
        return outgoing

    def _flush_uncovered(self) -> None:
        """Coverage for interventions no plan could cover (nothing observed, off, or a blocked shadow plan)."""
        for pending in self.pending_coverage:
            self.log("coverage", request=self.requests, covered="none", selected_units=0,
                     **{k: v for k, v in pending.items() if k != "spans"}, changed_spans=len(pending["spans"]))
        self.pending_coverage = []

    def _rewrite(self, messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        self.refresh()
        by_id: dict[str, dict[str, Any]] = {}
        for message in messages:
            if message.get("role") == "tool" and isinstance(message.get("tool_call_id"), str):
                if message["tool_call_id"] in by_id:
                    raise FreshCtxBlocked("duplicate tool result")
                by_id[message["tool_call_id"]] = message
        result_ids = [result_id for result_id in self.observed if result_id in by_id]
        try:
            plan = self.client.request("prepare", {"request_id": str(uuid4()), "result_ids": result_ids, "budget_bytes": self.budget_bytes})
        except RuntimeError as error:
            raise FreshCtxBlocked(f"prepare failed: {error}") from error
        projection = base64.b64decode(plan["projection_utf8_base64"]).decode("utf-8")
        if revision_for(projection) != plan["projection_sha256"] or len(projection.encode("utf-8")) > self.budget_bytes:
            raise FreshCtxBlocked("invalid projection hash or budget")
        replacements: dict[str, str] = {}
        for replacement in plan["replacements"]:
            result_id = replacement["result_id"]
            record = self.observed.get(result_id)
            message = by_id.get(result_id)
            native = message.get("content") if message else None
            extra = message.get("extra", {}) if message else {}
            if (
                record is None or message is None or result_id in replacements
                or replacement["expected_sha256"] != record.content_sha256
                or not isinstance(native, str) or _sha(native) != record.rendered_sha256
                or extra.get("raw_output", record.output) != record.output
                or not isinstance(replacement.get("marker"), str)
            ):
                raise FreshCtxBlocked("native tool result changed; entire FreshCtx plan discarded")
            replacements[result_id] = self.render({"output": replacement["marker"], "returncode": record.returncode, "exception_info": record.exception_info})
        missing = [result_id for result_id in result_ids if result_id not in replacements]
        if missing:
            raise FreshCtxBlocked("FreshCtx has no observation for an observed shell read")
        outgoing = copy.deepcopy(messages)
        for message in outgoing:
            if message.get("role") == "tool" and message.get("tool_call_id") in replacements:
                message["content"] = replacements[message["tool_call_id"]]
        if projection:
            outgoing.append({"role": "user", "content": projection})
        self._log_coverage(plan, replacements)
        committed = self.client.request("commit", {"plan_id": plan["plan_id"]})
        if committed.get("applied") is not True:
            raise FreshCtxBlocked("FreshCtx did not commit")
        markers = [replacement["marker"] for replacement in plan["replacements"]]
        return outgoing, {
            "observed_results": len(result_ids),
            "replaced": len(replacements),
            "projection_bytes": len(projection.encode("utf-8")),
            "selected": len(plan["selected"]),
            "omitted": [item.get("reason") for item in plan["omitted"]],
            "unresolved": [item.get("reason") for item in plan["unresolved"]],
            "unavailable_markers": sum(1 for marker in markers if " " in marker),
        }

    def _log_coverage(self, plan: dict[str, Any], replacements: dict[str, str]) -> None:
        if not self.pending_coverage:
            return
        unit_paths = {}
        for replacement in plan["replacements"]:
            unit_id = replacement["marker"].strip("[]").split(" ")[0]
            unit_paths[unit_id] = self.observed[replacement["result_id"]].path
        for pending in self.pending_coverage:
            units = [
                (state["currentRange"]["startByte"], state["currentRange"]["endByte"])
                for unit_id, state in plan["unit_states"].items()
                if unit_paths.get(unit_id) == pending["path"]
            ]
            self.log("coverage", request=self.requests, covered=covered(pending["spans"], units), selected_units=len(units),
                     **{k: v for k, v in pending.items() if k != "spans"}, changed_spans=len(pending["spans"]))
        self.pending_coverage = []

    def close(self) -> None:
        if self.client is not None:
            self.client.close()


def _tojson(value: str) -> str:
    """Jinja's `tojson` for a string: JSON with <, >, & and ' escaped."""
    return (json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e")
            .replace("&", "\\u0026").replace("'", "\\u0027"))


def _normalized_patch(diff: str, path: str) -> str:
    """The scenario's own hunks for `path`, with plain ---/+++ headers (fallback when reverse application fails)."""
    out, keep = [], False
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git"):
            keep = line.rstrip("\n").endswith(f" b/{path}")
            if keep:
                out += [f"--- a/{path}\n", f"+++ b/{path}\n"]
        elif keep and not line.startswith(("index ", "--- ", "+++ ")):
            out.append(line)
    return "".join(out)


# ---------------------------------------------------------------- wrappers

class FreshCtxEnvironment:
    """Wrap a Mini-SWE-Agent environment so every action passes through the bridge."""

    def __init__(self, inner: Any, bridge: MiniBridge) -> None:
        self._inner = inner
        self._bridge = bridge

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def execute(self, action: dict[str, Any], cwd: str = "", **kwargs: Any) -> dict[str, Any]:
        drain = getattr(self._inner, "drain_interventions", None)
        return self._bridge.execute(action, lambda a: self._inner.execute(a, cwd, **kwargs), drain)


class FreshCtxModel:
    """Wrap a Mini-SWE-Agent model so each query dispatches the bridge's outgoing copy."""

    def __init__(self, inner: Any, bridge: MiniBridge) -> None:
        self._inner = inner
        self._bridge = bridge

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def query(self, messages: list[dict[str, Any]], **kwargs: Any) -> dict:
        return self._inner.query(self._bridge.outgoing(messages), **kwargs)


def observation_renderer(model: Any, agent: Any) -> Callable[[dict[str, Any]], str]:
    """Render one observation exactly as `agent` will add it for a tool call."""

    cache: dict[str, Any] = {}

    def render(output: dict[str, Any]) -> str:
        step = getattr(agent, "n_calls", None)
        if cache.get("step", object()) != step:  # template variables once per agent step
            cache.update(step=step, variables=agent.get_template_vars())
        message = {"extra": {"actions": [{"command": "", "tool_call_id": "freshctx"}]}}
        return model.format_observation_messages(message, [output], cache["variables"])[0]["content"]

    return render
