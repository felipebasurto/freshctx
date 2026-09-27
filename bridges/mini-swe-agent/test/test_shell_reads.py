import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from freshctx_mini import (  # noqa: E402
    changed_spans,
    covered,
    output_matches,
    parse_patch,
    parse_shell_read,
    render_read,
    reverse_apply,
    unified,
)

SOURCES = {
    "trailing newline": "def a():\n    return 1\n\n\ndef b():\n    return 'é'\n",
    "no trailing newline": "x = 1\n\ny = 2\nz = 3",
    "crlf": "first\r\nsecond\r\n\r\nthird\r\n",
    "tabs and spaces": "\tindented\n    spaced  \n\n",
}

COMMANDS = [
    "cat f.py",
    "cat -n f.py",
    "nl -ba f.py",
    "sed -n '2,3p' f.py",
    "sed -n '3p' f.py",
    "sed -n '2,99p' f.py",
    "nl -ba f.py | sed -n '2,4p'",
    "nl -ba f.py | sed -n '1,200p'",
    "head -n 2 f.py",
    "head -n 99 f.py",
    "tail -n 2 f.py",
    "tail -n 99 f.py",
]


class ParseTests(unittest.TestCase):
    def test_allowlist(self):
        cases = {
            "cat src/a.py": ("src/a.py", None, True, False),
            "cat -n src/a.py": ("src/a.py", None, True, True),
            "nl -ba src/a.py": ("src/a.py", None, True, True),
            "sed -n '10,20p' src/a.py": ("src/a.py", None, False, False),
            "nl -ba src/a.py | sed -n '10,20p'": ("src/a.py", None, False, True),
            "head -n 5 a.py": ("a.py", None, False, False),
            "tail -n 5 a.py": ("a.py", None, False, False),
            "cd /testbed && nl -ba django/db/models/query.py | sed -n '1,80p'": ("django/db/models/query.py", "/testbed", False, True),
        }
        for command, (path, cwd, whole, numbered) in cases.items():
            read = parse_shell_read(command)
            self.assertIsNotNone(read, command)
            self.assertEqual((read.path, read.cwd, read.whole, read.numbered), (path, cwd, whole, numbered), command)
        self.assertEqual(parse_shell_read("sed -n '10,20p' a.py").end, 20)
        self.assertEqual(parse_shell_read("tail -n 7 a.py").tail, 7)

    def test_rejects_side_effects_and_compound_commands(self):
        for command in [
            "cat a.py > b.py", "cat a.py; rm a.py", "cat a.py && cat b.py", "cat a.py | head",
            "sed -i 's/a/b/' a.py", "sed -n '1,2p;3p' a.py", "sed -n '1,$p' a.py", "cat $FILE",
            "cat *.py", "cat a.py b.py", "head -5 a.py", "tail -n +5 a.py", "grep -n x a.py",
            "cat -A a.py", "nl a.py", "cd /x && cd /y && cat a.py", "cat -- a.py", "cat ~/a.py",
            "cat a.py\ncat b.py", "cat `echo a.py`", "cat 'a b.py'", "head -n 0 a.py",
        ]:
            self.assertIsNone(parse_shell_read(command), command)


class RenderTests(unittest.TestCase):
    def test_rendering_matches_the_real_tools_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as root:
            for label, text in SOURCES.items():
                Path(root, "f.py").write_bytes(text.encode("utf-8"))
                for command in COMMANDS:
                    actual = subprocess.run(["bash", "-c", command], cwd=root, capture_output=True).stdout.decode("utf-8")
                    expected, start, raw = render_read(parse_shell_read(command), text)
                    self.assertTrue(output_matches(expected, actual), f"{label}: {command}: {expected!r} != {actual!r}")
                    self.assertEqual(text[start:start + len(raw)], raw)

    def test_any_changed_byte_is_a_mismatch(self):
        text = SOURCES["trailing newline"]
        expected, _, _ = render_read(parse_shell_read("nl -ba f.py | sed -n '1,3p'"), text)
        self.assertFalse(output_matches(expected, expected.replace("return 1", "return 2")))
        self.assertFalse(output_matches(expected, expected.replace("     1\t", "1\t")))
        self.assertFalse(output_matches(expected, expected + "\n"))  # only a missing final newline is tolerated


PATCH = """diff --git a/pkg/m.py b/pkg/m.py
index 1111111..2222222 100644
--- a/pkg/m.py
+++ b/pkg/m.py
@@ -2,3 +2,4 @@ def f():
     a = 1
-    b = 2
+    b = 3
+    c = 4
     return a
"""


class PatchTests(unittest.TestCase):
    def test_reverse_apply_and_notice_diff(self):
        before = "def f():\n    a = 1\n    b = 2\n    return a\n"
        after = "def f():\n    a = 1\n    b = 3\n    c = 4\n    return a\n"
        hunks = parse_patch(PATCH)["pkg/m.py"]
        self.assertEqual(reverse_apply(after, hunks), before)
        self.assertEqual(unified("pkg/m.py", before, after), (
            "--- a/pkg/m.py\n+++ b/pkg/m.py\n@@ -1,4 +1,5 @@\n def f():\n     a = 1\n-    b = 2\n+    b = 3\n+    c = 4\n     return a\n"))
        self.assertIsNone(reverse_apply(after.replace("c = 4", "c = 5"), hunks))

    def test_no_newline_marker(self):
        diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n"
        self.assertEqual(reverse_apply("new", parse_patch(diff)["x"]), "old")

    def test_changed_spans_and_coverage(self):
        before = "a\nb\nc\nd\n"
        after = "a\nB\nc\nd\n"
        spans = changed_spans(before, after)
        self.assertEqual(spans, [(2, 4)])
        self.assertEqual(covered(spans, [(0, 4)]), "full")
        self.assertEqual(covered(spans, [(0, 2), (2, 3)]), "partial")
        self.assertEqual(covered(spans, [(0, 2), (2, 4)]), "full")
        self.assertEqual(covered(spans, [(4, 8)]), "none")
        self.assertEqual(changed_spans("a\nb\n", "a\n"), [(0, 2)])


if __name__ == "__main__":
    unittest.main()
