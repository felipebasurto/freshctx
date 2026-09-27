"""End to end with Mini-SWE-Agent 2.4.1's DefaultAgent on a local git repository.

A scripted model issues shell reads; a local environment stands in for SWE-Touch's
host bridge: it applies a user patch right after a chosen command (before the
agent sees the result) and reports the intervention, as `/exec` does.
"""

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")
os.environ.setdefault("MSWEA_CONFIGURED", "true")

from minisweagent.agents.default import DefaultAgent  # noqa: E402
from minisweagent.config import get_config_from_spec  # noqa: E402
from minisweagent.environments.local import LocalEnvironment  # noqa: E402
from minisweagent.models.test_models import DeterministicToolcallModel, make_toolcall_output  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freshctx_mini import (  # noqa: E402
    FreshCtxBlocked,
    FreshCtxEnvironment,
    FreshCtxModel,
    MiniBridge,
    NOTICE_TEMPLATE,
    observation_renderer,
    unified,
)

MINI = get_config_from_spec("mini")

LEXER = '''"""Tokeniser."""


def scan_number(text, index):
    end = index
    while end < len(text) and text[end].isdigit():
        end += 1
    return text[index:end], end


def scan_word(text, index):
    end = index
    while end < len(text) and text[end].isalpha():
        end += 1
    return text[index:end], end


def scan_symbol(text, index):
    return text[index], index + 1


def tokens(text):
    out = []
    index = 0
    while index < len(text):
        if text[index].isdigit():
            token, index = scan_number(text, index)
        elif text[index].isalpha():
            token, index = scan_word(text, index)
        else:
            token, index = scan_symbol(text, index)
        out.append(token)
    return out
'''

UTIL = "LIMIT = 10\n\n\ndef clamp(value):\n    return min(value, LIMIT)\n"

# The user's edit, as SWE-Touch stores it: a git diff against the repository.
USER_PATCH = '''diff --git a/pkg/lexer.py b/pkg/lexer.py
index 0000000..1111111 100644
--- a/pkg/lexer.py
+++ b/pkg/lexer.py
@@ -12,6 +12,8 @@ def scan_word(text, index):
 def scan_word(text, index):
     end = index
     while end < len(text) and text[end].isalpha():
+        if text[end] == "_":
+            break
         end += 1
     return text[index:end], end

'''


def git(root, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


class TouchEnvironment(LocalEnvironment):
    """LocalEnvironment plus the two things SWE-Touch's host bridge adds."""

    def __init__(self, *, repo, patches, **kwargs):
        super().__init__(cwd=repo, **kwargs)
        self.repo = repo
        self.patches = dict(patches)  # command index -> diff
        self.index = 0
        self.pending = []
        self.internal_calls = 0

    def execute(self, action, cwd="", *, timeout=None):
        self.index += 1
        try:
            return super().execute(action, cwd, timeout=timeout)
        finally:
            diff = self.patches.pop(self.index, None)
            if diff is not None:
                subprocess.run(["git", "apply", "-"], input=diff.encode(), cwd=self.repo, check=True)
                self.pending.append({"scenario_id": "s1", "intervention_index": 1, "patch_applied": True, "patch_diff": diff})

    def drain_interventions(self):
        pending, self.pending = self.pending, []
        return pending

    def internal_exec(self, command, cwd):
        self.internal_calls += 1
        done = subprocess.run(["bash", "-c", command], cwd=cwd or self.repo, capture_output=True)
        return done.stdout.decode("utf-8"), done.returncode


class RecordingModel(DeterministicToolcallModel):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.requests = []

    def query(self, messages, **kwargs):
        self.requests.append(copy.deepcopy(messages))
        return super().query(messages, **kwargs)


def scripted(commands):
    outputs = []
    for number, command in enumerate(commands, start=1):
        call = f"call_{number}"
        outputs.append(make_toolcall_output(
            f"step {number}",
            [{"id": call, "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": command})}}],
            [{"command": command, "tool_call_id": call}],
        ))
    return outputs


def decode_frames(projection):
    frames = []
    rest = projection.encode("utf-8")
    while rest:
        header, rest = rest.split(b"\n", 1)
        name, _, size = header.decode("utf-8").rpartition(":")
        length = int(size.removesuffix("bytes"))
        path, _, kind = name.partition(":")
        frames.append((path, kind or "file", rest[:length].decode("utf-8")))
        rest = rest[length:]
    return frames


class AgentRun:
    def __init__(self, test, commands, *, mode="rewrite", notice=False, patches=None, refresh="all"):
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.repo = base / "repo"
        (self.repo / "pkg").mkdir(parents=True)
        (self.repo / "pkg" / "lexer.py").write_text(LEXER)
        (self.repo / "pkg" / "util.py").write_text(UTIL)
        git(self.repo, "init", "-q")
        git(self.repo, "add", ".")
        git(self.repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base")
        if callable(commands):
            commands = commands(str(self.repo))
        self.log = base / "freshctx.jsonl"
        self.env = TouchEnvironment(repo=str(self.repo), patches=patches or {})
        self.model = RecordingModel(outputs=scripted(commands), observation_template=MINI["model"]["observation_template"])
        self.bridge = MiniBridge(mirror_root=base / "mirror", repo_root=str(self.repo), internal_exec=self.env.internal_exec,
                                 mode=mode, notice=notice, refresh=refresh, session_id="test", log_path=self.log,
                                 audit_path=base / "audit.jsonl")
        test.addCleanup(self.bridge.close)
        agent_config = {**{k: v for k, v in MINI["agent"].items() if k != "mode"}, "cost_limit": 0}
        self.agent = DefaultAgent(FreshCtxModel(self.model, self.bridge), FreshCtxEnvironment(self.env, self.bridge), **agent_config)
        self.bridge.render = observation_renderer(self.model, self.agent)

    def run(self):
        return self.agent.run("Fix the lexer.")

    def events(self, kind):
        return [json.loads(line) for line in self.log.read_text().splitlines() if json.loads(line)["event"] == kind]

    def tool(self, messages, call):
        return next(m for m in messages if m.get("role") == "tool" and m.get("tool_call_id") == call)


TRIGGER = [
    "nl -ba pkg/lexer.py | sed -n '1,10p'",
    "cat pkg/util.py",
    f"cd {{repo}} && sed -n '11,20p' pkg/lexer.py",  # the user's edit lands right after this read
    "grep -n scan_word pkg/lexer.py",
    "perl -pi -e 's/LIMIT = 10/LIMIT = 20/' pkg/util.py",
    "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT",
]


def trigger(repo):
    return [command.replace("{repo}", repo) for command in TRIGGER]


class AgentTests(unittest.TestCase):
    def test_rewrite_replaces_reads_and_projects_current_code_byte_for_byte(self):
        run = AgentRun(self, trigger, patches={3: USER_PATCH})
        result = run.run()
        self.assertEqual(result["exit_status"], "Submitted")
        after = (run.repo / "pkg" / "lexer.py").read_text()
        self.assertIn('if text[end] == "_":', after)
        render = run.bridge.render

        # Request 4 is the first after the intervention.
        request = run.model.requests[3]
        native = run.agent.messages
        for call in ("call_1", "call_2", "call_3"):
            sent = run.tool(request, call)["content"]
            saved = run.tool(native, call)
            marker = json.loads(sent)["output"]
            self.assertRegex(marker, r"^\[[0-9a-f]{24}\]$")
            self.assertEqual(sent, render({"output": marker, "returncode": 0, "exception_info": ""}))
            self.assertEqual(saved["content"], render({"output": saved["extra"]["raw_output"], "returncode": 0, "exception_info": ""}))
        self.assertEqual(json.loads(run.tool(native, "call_3")["content"])["output"], "\n".join(LEXER.splitlines()[10:20]) + "\n")
        self.assertNotIn('text[end] == "_"', json.dumps(native[:9]))  # the saved history keeps what the agent saw

        # The projection is the last message and carries current bytes only.
        projection = request[-1]
        self.assertEqual(projection["role"], "user")
        frames = decode_frames(projection["content"])
        self.assertIn(("pkg/util.py", "file", UTIL), frames)
        state_at_request = {"pkg/lexer.py": after, "pkg/util.py": UTIL}  # util.py is edited only later
        for path, _, body in frames:
            self.assertIn(body, state_at_request[path])
        self.assertTrue(any('if text[end] == "_":' in body for _, _, body in frames))
        self.assertFalse(any("isalpha():\n        end += 1" in body for _, _, body in frames))

        # The grep output is not a read and stays native; the agent's own edit is projected.
        final = run.model.requests[-1]
        self.assertEqual(run.tool(final, "call_4")["content"], run.tool(native, "call_4")["content"])
        util_frame = [body for path, _, body in decode_frames(final[-1]["content"]) if path == "pkg/util.py"]
        self.assertEqual(util_frame, [UTIL.replace("LIMIT = 10", "LIMIT = 20")])

        coverage = run.events("coverage")
        self.assertEqual([(c["path"], c["covered"], c["observed_path_before"]) for c in coverage], [("pkg/lexer.py", "full", True)])
        observed = [c for c in run.events("command") if c["status"] == "observed"]
        self.assertEqual([c["index"] for c in observed], [1, 2, 3])
        requests = run.events("request")
        self.assertTrue(all(r["rewritten"] for r in requests[1:]))
        audit = [json.loads(line) for line in (run.log.parent / "audit.jsonl").read_text().splitlines()]
        self.assertEqual([entry["request"] for entry in audit], [1, 4, 5])
        self.assertEqual(audit[1]["messages"], [{k: v for k, v in m.items() if k != "extra"} for m in request])
        status = run.bridge.client.request("status")
        self.assertEqual(status["counts"]["committed_plans"], len(requests) - 1)

    def test_notice_arm_appends_the_e11c_notice_once_in_the_outgoing_copy_only(self):
        run = AgentRun(self, trigger, mode="off", notice=True, patches={3: USER_PATCH})
        run.run()
        before = LEXER
        after = (run.repo / "pkg" / "lexer.py").read_text()
        expected = NOTICE_TEMPLATE.format(path="pkg/lexer.py", diff=unified("pkg/lexer.py", before, after))
        self.assertEqual(expected.splitlines()[0], "[Note: pkg/lexer.py was changed outside this session after your earlier work. The change:")
        notices = [(index, m["content"]) for index, request in enumerate(run.model.requests) for m in request if str(m.get("content", "")).startswith("[Note:")]
        self.assertEqual(notices, [(3, expected)])
        self.assertEqual(run.model.requests[3][-1], {"role": "user", "content": expected})
        self.assertFalse(any(str(m.get("content", "")).startswith("[Note:") for m in run.agent.messages))
        self.assertEqual(run.env.internal_calls, 2)  # repository root + the patched file, nothing per read

    def test_refresh_changed_sends_native_requests_until_the_user_edit(self):
        run = AgentRun(self, trigger, patches={3: USER_PATCH}, refresh="changed")
        run.run()
        native = run.agent.messages
        for request in run.model.requests[:3]:  # before the edit: byte-identical to the saved history
            self.assertEqual(request, native[:len(request)])
        after = run.model.requests[3]
        marker = json.loads(run.tool(after, "call_3")["content"])["output"]
        self.assertRegex(marker, r"^\[[0-9a-f]{24}\]$")  # the read the edit touched
        self.assertEqual(run.tool(after, "call_2"), run.tool(native, "call_2"))  # util.py unchanged: native
        frames = decode_frames(after[-1]["content"])
        self.assertEqual({path for path, _, _ in frames}, {"pkg/lexer.py"})
        self.assertTrue(any('if text[end] == "_":' in body for _, _, body in frames))
        self.assertEqual([c["covered"] for c in run.events("coverage")], ["full"])
        final = run.model.requests[-1]  # the agent edited util.py itself: now it is refreshed too
        self.assertIn("pkg/util.py", {path for path, _, _ in decode_frames(final[-1]["content"])})

    def test_persistent_notice_stays_at_its_place_in_later_requests(self):
        run = AgentRun(self, trigger, mode="off", notice="persist", patches={3: USER_PATCH})
        run.run()
        note = run.model.requests[3][-1]
        self.assertTrue(note["content"].startswith("[Note: pkg/lexer.py was changed"))
        position = len(run.model.requests[3]) - 1
        for later in run.model.requests[4:]:
            self.assertEqual(later[position], note)
            self.assertEqual(later[:position] + later[position + 1:], run.agent.messages[:len(later) - 1])
        self.assertFalse(any(str(m.get("content", "")).startswith("[Note:") for m in run.agent.messages))

    def test_shadow_dispatches_native_requests_and_still_logs_coverage(self):
        run = AgentRun(self, trigger, mode="shadow", patches={3: USER_PATCH})
        run.run()
        for request in run.model.requests:
            self.assertEqual(request, run.agent.messages[:len(request)])
        self.assertEqual([c["covered"] for c in run.events("coverage")], ["full"])

    def test_later_range_read_does_not_narrow_a_whole_file_read(self):
        commands = ["cat pkg/lexer.py", "sed -n '30,40p' pkg/lexer.py", "echo done", "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"]
        run = AgentRun(self, commands, patches={2: USER_PATCH})
        run.run()
        frames = decode_frames(run.model.requests[2][-1]["content"])
        self.assertIn(("pkg/lexer.py", "file", (run.repo / "pkg" / "lexer.py").read_text()), frames)
        self.assertEqual([c["covered"] for c in run.events("coverage")], ["full"])

    def test_skips_reads_it_cannot_verify(self):
        commands = [
            "cat pkg/missing.py",
            "cat ../outside.py",
            "sed -n '1,3p' pkg/util.py",
            "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT",
        ]
        run = AgentRun(self, commands)
        (run.repo.parent / "outside.py").write_text("x = 1\n")
        run.bridge.max_output_chars = 10  # lines 1-3 of util.py print 13 characters: treated as elided
        run.run()
        reasons = [c.get("reason") for c in run.events("command") if c["status"] != "not_read"]
        self.assertEqual(reasons, ["missing", "outside_repository", "truncated"])
        self.assertEqual(run.model.requests[-1], run.agent.messages[:len(run.model.requests[-1])])

    def test_mismatched_output_is_never_observed(self):
        run = AgentRun(self, ["cat pkg/util.py", "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"])
        original = run.env.execute

        def tampered(action, cwd="", *, timeout=None):
            result = original(action, cwd, timeout=timeout)
            result["output"] = result["output"].replace("LIMIT = 10", "LIMIT = 11")
            return result

        run.env.execute = tampered
        run.run()
        self.assertEqual([c.get("reason") for c in run.events("command") if c["status"] != "not_read"], ["mismatch"])

    def test_rewrite_fails_closed_when_a_native_result_changed(self):
        run = AgentRun(self, ["cat pkg/util.py", "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"])
        run.run()
        messages = copy.deepcopy(run.agent.messages)
        tool = run.tool(messages, "call_1")
        tool["content"] = tool["content"].replace("LIMIT", "LIMlT")
        with self.assertRaises(FreshCtxBlocked):
            run.bridge.outgoing(messages)
        unobserved = copy.deepcopy(run.agent.messages)
        run.bridge.observed["call_9"] = run.bridge.observed["call_1"]
        unobserved.append({"role": "tool", "tool_call_id": "call_9", "content": run.tool(unobserved, "call_1")["content"]})
        with self.assertRaises(FreshCtxBlocked):
            run.bridge.outgoing(unobserved)


if __name__ == "__main__":
    unittest.main()
