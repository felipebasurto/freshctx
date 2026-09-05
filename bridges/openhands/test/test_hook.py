import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freshctx_openhands import Bridge, config_from_env, content_text, wrap_llm


STALE = "RATE = 10"
CURRENT = "RATE = 20"
SOURCE = f"{STALE}\nCURRENCY = \"EUR\"\n\ndef unread():\n    return 1\n"


def request(text):
    return {
        "model": "openhands-fixture",
        "messages": [
            {"role": "assistant", "content": None, "tool_calls": [{"id": "read_1", "type": "function", "function": {"name": "file_editor", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "read_1", "content": text},
        ],
    }


class HookTests(unittest.TestCase):
    def test_with_versus_without_and_no_fall_open(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, "price.py")
            path.write_text(SOURCE, encoding="utf-8")
            observed = "\n".join(SOURCE.splitlines()[:2])
            start = 0
            end = len(observed.encode("utf-8"))
            enabled = Bridge(root, "py-with")
            try:
                enabled.observe("read_1", "price.py", observed, start, end)
                path.write_text(SOURCE.replace(STALE, CURRENT), encoding="utf-8")
                rewritten = enabled.rewrite(request(observed))
                text = json.dumps(rewritten)
                self.assertIn(CURRENT, text)
                self.assertNotIn(STALE, text)
                self.assertNotIn("def unread", text)
                self.assertEqual(rewritten["messages"][1]["content"].startswith("["), True)
            finally:
                enabled.close()

            disabled = Bridge(root, "py-without", enabled=False)
            try:
                passthrough = disabled.rewrite(request(observed))
                self.assertEqual(content_text(passthrough["messages"][1]["content"]), observed)
                self.assertIn(STALE, json.dumps(passthrough))
                self.assertNotIn(CURRENT, json.dumps(passthrough))
            finally:
                disabled.close()

    def test_altered_result_does_not_dispatch_original(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "price.py").write_text(SOURCE, encoding="utf-8")
            observed = "\n".join(SOURCE.splitlines()[:2])
            bridge = Bridge(root, "py-reject")
            dispatched = []

            class LLM:
                def completion(self, messages, **kwargs):
                    dispatched.append(messages)
                    return "ok"

            try:
                bridge.observe("read_1", "price.py", observed, 0, len(observed.encode("utf-8")))
                payload = request(observed + " changed")
                llm = LLM()
                wrap_llm(llm, bridge)
                with self.assertRaises(RuntimeError):
                    llm.completion(payload["messages"])
                self.assertEqual(dispatched, [])
            finally:
                bridge.close()

    def test_fall_open_rejected(self):
        with self.assertRaises(RuntimeError):
            config_from_env({"FRESHCTX_FALL_OPEN": "1"})


if __name__ == "__main__":
    unittest.main()
