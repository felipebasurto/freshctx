import ast
import pathlib

source = pathlib.Path(__file__).with_name("freshctx_explainer.py").read_text()
tree = ast.parse(source)
lines = ["# FreshCtx explainer: narration script", "",
         "Generated from freshctx_explainer.py by `python narration.py`. Each line is one on-screen caption, in order.", ""]
for lang, index, heading in (("es", 0, "Español"), ("en", 1, "English")):
    lines += [f"## {heading}", ""]
    for scene in (n for n in tree.body if isinstance(n, ast.ClassDef) and n.name.startswith("S")):
        calls = sorted((n for n in ast.walk(scene) if isinstance(n, ast.Call) and getattr(n.func, "attr", None) in ("say", "chapter")), key=lambda n: n.lineno)
        lines += [f"### {scene.name}", ""]
        for call in calls:
            text = call.args[0] if call.func.attr == "say" else call.args[1]
            if isinstance(text, ast.Call) and getattr(text.func, "id", "") == "T":
                value = text.args[index].value
                lines.append(f"**{value}**" if call.func.attr == "chapter" else f"- {value}")
        lines.append("")
pathlib.Path(__file__).with_name("NARRATION.md").write_text("\n".join(lines))
