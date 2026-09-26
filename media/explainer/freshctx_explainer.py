import hashlib
import os
from pathlib import Path

import soundfile
from manim import *

VOICE = os.environ.get("FRESHCTX_VOICE", "am_michael")
SPEED = float(os.environ.get("FRESHCTX_VOICE_SPEED", "1.0"))
KOKORO_DIR = Path(os.environ.get("KOKORO_DIR", "/opt/tts"))
VOICE_CACHE = Path(__file__).with_name("build") / "voice"

BG = "#0e1014"
PANEL = "#1a1d24"
MONO = "DejaVu Sans Mono"
SANS = "DejaVu Sans"
OLD = RED_C
NEW = GREEN_C
HI = YELLOW_C
FRESH = TEAL_C
MUTED = GREY_B

config.background_color = BG

_kokoro = None


def speak(text):
    key = hashlib.sha1(f"{VOICE}|{SPEED}|{text}".encode()).hexdigest()[:16]
    path = VOICE_CACHE / f"{key}.wav"
    if not path.exists():
        global _kokoro
        if _kokoro is None:
            from kokoro_onnx import Kokoro
            _kokoro = Kokoro(str(KOKORO_DIR / "kokoro-v1.0.onnx"), str(KOKORO_DIR / "voices-v1.0.bin"))
        samples, rate = _kokoro.create(text, voice=VOICE, speed=SPEED, lang="en-us")
        VOICE_CACHE.mkdir(parents=True, exist_ok=True)
        soundfile.write(path, samples, rate)
    return path, soundfile.info(path).duration


def label(text, size=24, color=WHITE, weight=NORMAL, font=SANS):
    return Text(text, font=font, font_size=size, color=color, weight=weight)


class CodeLine(VGroup):
    def __init__(self, source, size=22, color=GREY_A, t2c=None):
        self.source = source
        self.body = Text("│" + source, font=MONO, font_size=size, color=color, t2c=t2c or {})
        self.body[0].set_opacity(0)
        super().__init__(self.body)

    def part(self, needle, occurrence=0):
        raw = "│" + self.source
        start = -1
        for _ in range(occurrence + 1):
            start = raw.index(needle, start + 1)
        before = len(raw[:start].replace(" ", ""))
        length = len(needle.replace(" ", ""))
        return self.body[before:before + length]


def code_block(lines, size=22, t2c=None, color=GREY_A, spacing=0.36):
    rows = VGroup()
    for index, source in enumerate(lines):
        row = CodeLine(source, size=size, color=color, t2c=t2c)
        anchor = row.body[0]
        row.shift(-anchor.get_left() + DOWN * spacing * index)
        rows.add(row)
    return rows


def card(content, title=None, color=GREY_D, pad=0.25, fill=PANEL, title_color=MUTED, title_size=18):
    box = SurroundingRectangle(content, buff=pad, corner_radius=0.12, color=color, stroke_width=2)
    box.set_fill(fill, opacity=1)
    box.set_z_index(-1)
    group = VGroup(box, content)
    if title:
        head = label(title, size=title_size, color=title_color, font=MONO)
        head.next_to(box, UP, buff=0.08, aligned_edge=LEFT)
        group.add(head)
    return group


def pill(text, width, color=GREY_D, size=18, font=MONO, text_color=WHITE):
    words = label(text, size=size, font=font, color=text_color)
    box = RoundedRectangle(corner_radius=0.1, width=width, height=words.height + 0.3, color=color, stroke_width=2)
    box.set_fill(PANEL, 1).set_z_index(-1)
    return VGroup(box, words.move_to(box))


def price_lines(multiplier):
    return ["function total(quantity) {", f"  return quantity * {multiplier};", "}"]


class Base(Scene):
    def setup(self):
        self.voice_until = 0.0

    def now(self):
        return self.renderer.time

    def settle(self):
        remaining = self.voice_until - self.now()
        if remaining > 0.02:
            self.wait(remaining)

    def say(self, text, spoken=None, pause=0.35):
        self.settle()
        path, duration = speak(spoken or text)
        self.add_sound(str(path))
        self.add_subcaption(text, duration=duration)
        self.voice_until = self.now() + duration + pause

    def clear_all(self, run_time=0.6):
        self.settle()
        if self.mobjects:
            self.play(*[FadeOut(m) for m in self.mobjects], run_time=run_time)

    def chapter(self, number, title):
        tag = label(f"{number}", size=30, color=HI, font=MONO)
        name = label(title, size=40, weight=BOLD)
        group = VGroup(tag, name).arrange(RIGHT, buff=0.35)
        line = Line(LEFT * 3, RIGHT * 3, color=GREY_D).next_to(group, DOWN, buff=0.25)
        self.play(FadeIn(group, shift=0.2 * UP), Create(line), run_time=0.8)
        self.wait(1.0)
        self.play(FadeOut(group), FadeOut(line), run_time=0.5)


class S1Hook(Base):
    def construct(self):
        title = label("Model context is not static", size=50, weight=BOLD)
        sub = label("FreshCtx", size=28, color=FRESH).next_to(title, DOWN, buff=0.4)
        self.play(Write(title), run_time=1.6)
        self.play(FadeIn(sub, shift=0.1 * UP))
        self.wait(1.2)
        self.play(FadeOut(title), FadeOut(sub))

        disk_code = code_block(price_lines(10), size=26, t2c={"10": HI}, spacing=0.44)
        disk = card(disk_code, "price.js", pad=0.3)
        disk.move_to(RIGHT * 3.4 + UP * 0.6)
        convo_title = label("conversation", size=28, color=MUTED).move_to(LEFT * 3.6 + UP * 3.1)
        disk_title = label("disk", size=28, color=MUTED).move_to(RIGHT * 3.4 + UP * 3.1)
        divider = DashedLine(UP * 3.4, DOWN * 3.4, color=GREY_D)

        self.play(FadeIn(convo_title), FadeIn(disk_title), Create(divider))
        self.play(FadeIn(disk, shift=0.2 * LEFT))
        self.say("A coding agent reads a function.")

        read_code = code_block(price_lines(10), size=24, t2c={"10": HI}, spacing=0.4)
        read = card(read_code, "read-1", color=BLUE_D, pad=0.28)
        read.move_to(LEFT * 3.6 + UP * 1.2)
        self.play(ReplacementTransform(disk_code.copy(), read_code), FadeIn(read[0]), FadeIn(read[2]), run_time=1.3)
        self.say("What it saw is saved in the conversation, as a tool result.")

        self.say("Then someone changes the multiplier to twenty.")
        old_num = disk_code[1].part("10")
        new_num = Text("20", font=MONO, font_size=26, color=NEW).move_to(old_num)
        self.play(Indicate(old_num, color=HI))
        self.play(Transform(old_num, new_num), Flash(new_num, color=NEW, flash_radius=0.4))

        self.say("The agent keeps working. So what code does the model see on its next call?")
        model = card(label("model", size=28, weight=BOLD), color=PURPLE_B, pad=0.32)
        model.move_to(LEFT * 3.6 + DOWN * 1.8)
        arrow = Arrow(read.get_bottom(), model.get_top(), buff=0.12, color=PURPLE_B)
        self.play(FadeIn(model), GrowArrow(arrow))

        self.say("The file on disk says twenty. But the old tool result still says ten.")
        self.play(Create(SurroundingRectangle(read_code[1].part("10"), color=OLD, buff=0.06)),
                  Create(SurroundingRectangle(disk_code[1].part("10"), color=NEW, buff=0.06)))

        self.say("The tools act on one version of the file. The model reasons from another.")
        self.play(Indicate(disk, color=NEW, scale_factor=1.04))
        self.play(Indicate(read, color=OLD, scale_factor=1.04))

        self.say("The agent could read the file again, and often it does. "
                 "But then freshness depends on the model deciding to repeat a tool call.")
        self.say("What if the software maintaining the conversation took responsibility for refreshing code instead? "
                 "That question became FreshCtx.",
                 spoken="What if the software maintaining the conversation took responsibility for refreshing code instead? "
                        "That question became Fresh Context.")
        self.clear_all()


class S2Cache(Base):
    def construct(self):
        self.chapter("1", "A conversation is also a cache")

        harness = card(label("harness", size=26, weight=BOLD), color=BLUE_C, pad=0.3).move_to(LEFT * 5 + UP * 0.5)
        model = card(label("model", size=26, weight=BOLD), color=PURPLE_B, pad=0.3).move_to(RIGHT * 5 + UP * 0.5)
        names = ["system", "user", "read-1", "assistant", "user"]
        msgs = VGroup(*[pill(n, 2.8, color=BLUE_D if n == "read-1" else GREY_D) for n in names])
        msgs.arrange(DOWN, buff=0.14).move_to(UP * 0.5)
        brace = Brace(msgs, RIGHT, color=GREY_B)
        self.say("An agent pairs a language model with a harness: "
                 "the program that runs tools, records their results, and builds the next request.")
        self.play(FadeIn(harness))
        self.play(LaggedStart(*[FadeIn(m, shift=0.15 * RIGHT) for m in msgs], lag_ratio=0.15), run_time=1.4)
        self.play(GrowFromCenter(brace), FadeIn(model))
        a1 = Arrow(harness.get_right(), msgs.get_left(), buff=0.15, color=BLUE_C)
        a2 = Arrow(brace.get_right(), model.get_left(), buff=0.15, color=PURPLE_B)
        self.play(GrowArrow(a1), GrowArrow(a2))
        self.say("The model sees only what is in that request. "
                 "It does not automatically see a later edit to a file it read earlier.")
        self.play(Indicate(msgs[2], color=BLUE_C))
        self.clear_all()

        result = card(code_block(price_lines(10), t2c={"10": HI}, size=24, spacing=0.4), "read-1", color=BLUE_D, pad=0.28)
        result.move_to(UP * 0.8)
        job1 = label("history", size=30, weight=BOLD, color=BLUE_B).next_to(result, LEFT, buff=1.2)
        job2 = label("source", size=30, weight=BOLD, color=FRESH).next_to(result, RIGHT, buff=1.2)
        self.say("So a file read result has two jobs.")
        self.play(FadeIn(result))
        self.say("It records what a tool returned at a particular moment. "
                 "And it supplies source code for all the reasoning that follows.")
        self.play(FadeIn(job1, shift=0.2 * RIGHT))
        self.play(FadeIn(job2, shift=0.2 * LEFT))
        ok1 = label("✓", size=40, color=NEW).next_to(job1, DOWN, buff=0.3)
        ok2 = label("✓", size=40, color=NEW).next_to(job2, DOWN, buff=0.3)
        self.play(FadeIn(ok1), FadeIn(ok2))
        self.say("Those two jobs agree, right up until the file changes.")
        self.play(Flash(result, color=HI, flash_radius=1.6))
        bad2 = label("✗", size=40, color=OLD).move_to(ok2)
        self.play(Transform(ok2, bad2), job2.animate.set_color(OLD))
        self.say("As history, it is still correct. As source, it is now wrong.")
        self.clear_all()

        def mini(num, title):
            color = {10: OLD, 20: NEW}[num]
            return card(label(f"quantity * {num}", size=20, font=MONO, color=color), title, pad=0.16, title_size=15)

        xs = [-4.5, 0, 4.5]
        heads = VGroup(
            label("read again", size=26, weight=BOLD, color=BLUE_B),
            label("compact", size=26, weight=BOLD, color=GOLD_B),
            label("FreshCtx", size=26, weight=BOLD, color=FRESH),
        )
        for head, x in zip(heads, xs):
            head.move_to([x, 2.9, 0])

        r1 = mini(10, "read-1").move_to([xs[0], 1.4, 0])
        r2 = mini(20, "read-2").move_to([xs[0], 0.0, 0])
        self.say("The usual ways out each have a catch.")
        self.play(FadeIn(heads[0]), FadeIn(r1))
        self.say("Reading again adds another copy. Each one was true at some moment, and now they all sit in context together.")
        self.play(FadeIn(r2, shift=0.1 * DOWN))
        self.play(Indicate(r1, color=OLD), Indicate(r2, color=NEW))

        src = VGroup(mini(10, "read-1"), mini(10, "…")).arrange(DOWN, buff=0.45).move_to([xs[1], 0.7, 0])
        summary = card(label("“total × 10”", size=22, color=OLD), "summary", color=GOLD_D, pad=0.18, title_size=15).move_to([xs[1], 0.7, 0])
        self.play(FadeIn(heads[1]), FadeIn(src))
        self.say("Compacting history into a summary can keep an obsolete fact alive, long after the source behind it is gone.")
        self.play(ReplacementTransform(src, summary))

        saved = mini(10, "saved").move_to([xs[2], 1.4, 0])
        marker = card(label("[a2bc5d45…]", size=18, font=MONO, color=MUTED), "outgoing", pad=0.14, title_size=15)
        view = mini(20, "current view")
        out = VGroup(marker, view).arrange(DOWN, buff=0.45).move_to([xs[2], -0.6, 0])
        self.play(FadeIn(heads[2]), FadeIn(saved))
        self.say("FreshCtx splits the two jobs apart. Saved history is never touched. "
                 "Only the copy that goes out to the model is rewritten.",
                 spoken="Fresh Context splits the two jobs apart. Saved history is never touched. "
                        "Only the copy that goes out to the model is rewritten.")
        self.play(TransformFromCopy(saved, out), run_time=1.2)
        self.clear_all()


class S3Pipeline(Base):
    def construct(self):
        self.chapter("2", "From one read to the next request")

        agent = card(label("agent", size=26, weight=BOLD), color=BLUE_C, pad=0.3).move_to(LEFT * 4.6 + UP * 2.6)
        bridge = card(label("bridge", size=22, font=MONO), color=BLUE_D, pad=0.25).next_to(agent, DOWN, buff=0.35)
        engine = card(label("FreshCtx", size=26, weight=BOLD), color=FRESH, pad=0.3)
        engine.move_to([3.6, bridge.get_y(), 0])
        link = DoubleArrow(bridge.get_right(), engine.get_left(), buff=0.15, color=GREY_B)
        self.say("FreshCtx is a small local process that runs beside the agent. "
                 "A bridge connects it to the host's file reader, and to the last hook before a request is sent.",
                 spoken="Fresh Context is a small local process that runs beside the agent. "
                        "A bridge connects it to the host's file reader, and to the last hook before a request is sent.")
        self.play(FadeIn(agent), FadeIn(bridge))
        self.play(FadeIn(engine), GrowArrow(link))
        self.say("They talk in newline-delimited JSON. The engine itself never calls a model.")
        self.play(Indicate(link, color=HI))

        steps = ["observe", "prepare", "apply", "commit"]
        chips = VGroup(*[pill(s, 2.3, color=GREY_C, size=22, font=SANS) for s in steps]).arrange(RIGHT, buff=0.55)
        chips.move_to(DOWN * 1.0)
        arrows = VGroup(*[Arrow(chips[i].get_right(), chips[i + 1].get_left(), buff=0.06, color=GREY_B,
                                max_tip_length_to_length_ratio=0.3) for i in range(3)])
        self.say("The normal path has four steps.")
        self.play(LaggedStart(*[FadeIn(c, shift=0.1 * UP) for c in chips], lag_ratio=0.2), Create(arrows))
        lines = [
            "Observe: record the exact bytes a read returned.",
            "Prepare: find that code in the current workspace, and plan a rewrite.",
            "Apply: check the plan against the real tool results, and rewrite a copy of the request.",
            "Commit: recheck the selected files before that copy is allowed to go out.",
        ]
        for i, text in enumerate(lines):
            self.say(text)
            anims = [chips[i][0].animate.set_stroke(HI, width=3)]
            if i:
                anims.append(chips[i - 1][0].animate.set_stroke(GREY_C, width=2))
            self.play(*anims, run_time=0.5)
        self.clear_all()

        code = code_block(price_lines(10), size=26, t2c={"10": HI}, spacing=0.44)
        file_card = card(code, "price.js", pad=0.3).move_to(LEFT * 3.4 + UP * 1.2)
        self.play(FadeIn(file_card))
        box = SurroundingRectangle(code, color=HI, buff=0.12)
        rng = label("[0, 52)", size=26, font=MONO, color=HI).next_to(file_card, DOWN, buff=0.35)
        self.say("Take our function. When the read succeeds, the bridge tells FreshCtx exactly where those bytes came from: "
                 "byte zero up to byte fifty-two.",
                 spoken="Take our function. When the read succeeds, the bridge tells Fresh Context exactly where those bytes came from: "
                        "byte zero, up to byte fifty-two.")
        self.play(Create(box), FadeIn(rng))
        self.say("Bytes, not characters. An emoji takes several bytes, and the line numbers a reader adds are not source at all.")

        ids = VGroup(
            label("read-1", size=26, font=MONO, color=BLUE_B),
            label("unit", size=26, font=MONO, color=FRESH),
            label("sha256", size=26, font=MONO, color=HI),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.55).move_to(RIGHT * 3.6 + UP * 1.2)
        self.say("FreshCtx keeps three separate identities.",
                 spoken="Fresh Context keeps three separate identities.")
        self.play(FadeIn(ids[0], shift=0.1 * LEFT))
        self.say("The tool result ID ties a plan to one message.", spoken="The tool result I D ties a plan to one message.")
        self.play(Indicate(ids[0], color=BLUE_B))
        self.play(FadeIn(ids[1], shift=0.1 * LEFT))
        self.say("The unit names the piece of code being tracked.")
        self.play(FadeIn(ids[2], shift=0.1 * LEFT))
        self.say("And a SHA-256 revision pins down particular bytes.", spoken="And a shaw two fifty-six revision pins down particular bytes.")
        self.clear_all()

        saved_title = label("saved history", size=26, color=MUTED).move_to(LEFT * 3.6 + UP * 3.2)
        out_title = label("outgoing copy", size=26, color=FRESH).move_to(RIGHT * 3.4 + UP * 3.2)
        div = DashedLine(UP * 3.5, DOWN * 3.5, color=GREY_D)

        def history(tool_content):
            return VGroup(
                pill("read(price.js)", 3.2, size=17),
                tool_content,
                pill("what does total(3) return?", 3.6, size=17, font=SANS),
            ).arrange(DOWN, buff=0.22, aligned_edge=LEFT)

        def tool():
            return card(code_block(price_lines(10), size=18, t2c={"10": OLD}, spacing=0.32), "read-1", color=BLUE_D, pad=0.16, title_size=15)

        saved_tool = tool()
        saved = history(saved_tool).next_to(saved_title, DOWN, buff=0.4)
        out_tool = tool()
        out = history(out_tool).next_to(out_title, DOWN, buff=0.4)
        self.play(FadeIn(saved_title), FadeIn(saved), Create(div))
        self.say("Now the file changes, and the agent is about to send its next request. The bridge makes a copy.")
        self.play(FadeIn(out_title), TransformFromCopy(saved, out), run_time=1.2)

        marker = card(label("[a2bc5d45e8a9…]", size=17, font=MONO, color=MUTED), "read-1", pad=0.16, title_size=15)
        marker.move_to(out_tool, aligned_edge=LEFT)
        self.say("In the copy, the old result becomes a short marker. The tool call and its result stay paired.")
        self.play(ReplacementTransform(out_tool, marker))
        self.play(out[2].animate.next_to(marker, DOWN, buff=0.22, aligned_edge=LEFT))

        proj_code = code_block(["price.js:symbol:52bytes"] + price_lines(20), size=18,
                               t2c={"20": NEW, "price.js:symbol:52bytes": FRESH}, spacing=0.32)
        proj = card(proj_code, color=FRESH, pad=0.16)
        proj.next_to(out[2], DOWN, buff=0.22, aligned_edge=LEFT)
        self.say("And the current code is appended as a new message: the projection.")
        self.play(FadeIn(proj, shift=0.1 * UP))
        self.say("Saved history still says ten. Nothing was erased. Only what travels to the model changed.")
        self.play(Indicate(saved_tool, color=OLD), Indicate(proj, color=NEW))
        self.say("One subtlety. Only observations still present in the outgoing request count. "
                 "If compaction dropped a read, it does not quietly come back.")
        self.say("You can run this exact example with npm run demo. It uses the real engine, and never calls a model.",
                 spoken="You can run this exact example with N P M run demo. It uses the real engine, and never calls a model.")
        self.clear_all()


class S4Identity(Base):
    def construct(self):
        self.chapter("3", "What counts as the same code?")
        self.say("Refreshing a whole file is easy: remember its path, and read it again. "
                 "Refreshing a small piece means deciding what that piece is, after edits have moved it.")
        rows = [("file", "path", NEW), ("symbol", "Tree-sitter selector", FRESH), ("region", "bytes + anchors", GOLD_B)]
        table = VGroup()
        for i, (name, how, color) in enumerate(rows):
            y = 1.6 - i * 1.0
            name_m = label(name, size=32, weight=BOLD, color=color)
            name_m.move_to([-3.2 + name_m.width / 2, y, 0])
            how_m = label(how, size=26, color=GREY_A, font=MONO)
            how_m.move_to([0.4 + how_m.width / 2, y, 0])
            table.add(VGroup(name_m, how_m))
        self.say("FreshCtx uses three kinds of unit.", spoken="Fresh Context uses three kinds of unit.")
        self.play(LaggedStart(*[FadeIn(r, shift=0.1 * RIGHT) for r in table], lag_ratio=0.4), run_time=1.8)
        self.clear_all()

        code = code_block(price_lines(20), size=24, t2c={"20": NEW}, spacing=0.4)
        file_card = card(code, "price.js", pad=0.3).move_to(LEFT * 3.2 + UP * 1.2)
        offs = label("[0, 52)", size=24, font=MONO, color=HI).next_to(file_card, DOWN, buff=0.3)
        tree = VGroup(
            label("program", size=22, font=MONO, color=MUTED),
            label("function", size=22, font=MONO, color=FRESH),
            label('"total"', size=22, font=MONO, color=HI),
        ).arrange(DOWN, buff=0.6).move_to(RIGHT * 3.6 + UP * 1.2)
        edges = VGroup(Line(tree[0].get_bottom(), tree[1].get_top(), buff=0.1, color=GREY_C),
                       Line(tree[1].get_bottom(), tree[2].get_top(), buff=0.1, color=GREY_C))
        self.play(FadeIn(file_card), FadeIn(offs))
        self.say("In Python, JavaScript, TypeScript, Go and Rust, Tree-sitter can turn a byte range inside a function into a symbol.")
        self.play(FadeIn(tree), Create(edges))
        self.say("Now insert a line above it. Every byte offset shifts, but the selector does not.")
        lines = ["const TAX = 0.21;", "", "function total(quantity) {", "  return quantity * 20;", "}"]
        code2 = code_block(lines, size=24, t2c={"20": NEW, "const TAX = 0.21;": GOLD_B}, spacing=0.4)
        file2 = card(code2, "price.js", pad=0.3).move_to(file_card.get_top(), aligned_edge=UP)
        offs2 = label("[19, 71)", size=24, font=MONO, color=HI).next_to(file2, DOWN, buff=0.3)
        self.play(ReplacementTransform(file_card, file2), ReplacementTransform(offs, offs2), run_time=1.2)
        hl = SurroundingRectangle(VGroup(code2[2], code2[4]), color=FRESH, buff=0.08)
        self.say("FreshCtx finds the declaration again, and projects its current body.",
                 spoken="Fresh Context finds the declaration again, and projects its current body.")
        self.play(Create(hl), Indicate(tree[2], color=FRESH))
        self.say("Notice this can widen the read. Seeing one line inside a function may bring the whole function along.")
        self.play(Indicate(code2[3], color=HI))
        self.say("And when a language is unsupported, or the symbol is lost, it can fall back to the whole current file.")
        region = SurroundingRectangle(code2[0], color=GOLD_B, buff=0.08)
        self.play(FadeOut(hl), Create(region))
        self.say("Top-level code like this constant stays a region. FreshCtx keeps nearby bytes as anchors, "
                 "and searches for the span after edits. That identity is a heuristic.",
                 spoken="Top-level code like this constant stays a region. Fresh Context keeps nearby bytes as anchors, "
                        "and searches for the span after edits. That identity is a heuristic.")
        self.clear_all()

        self.say("And heuristics have traps. Here is the subtlest bug the audit found.")
        block = ["if (x > 0) {", "  y = y + 1;", "}"]
        a = card(code_block(block, size=24, spacing=0.4), "A", color=BLUE_D, pad=0.25)
        b = card(code_block(block, size=24, spacing=0.4), "B", pad=0.25)
        pair = VGroup(a, b).arrange(DOWN, buff=0.7).move_to(LEFT * 2.8 + UP * 0.3)
        self.play(FadeIn(pair))
        self.say("A file holds two identical blocks. The agent read the first one.")
        self.play(Indicate(a, color=BLUE_B))
        self.say("Then the first block changes. The second does not.")
        changed = CodeLine("  y = y + 2;", size=24, t2c={"2": NEW}).move_to(a[1][1], aligned_edge=LEFT)
        self.play(Transform(a[1][1], changed))
        self.say("Search the whole file for the old bytes, and you get a perfect match. In the wrong block.")
        match = SurroundingRectangle(b, color=NEW, buff=0.06)
        self.play(Create(match))
        self.play(match.animate.set_color(OLD))
        wrong = label("✗", size=60, color=OLD).next_to(b, RIGHT, buff=0.6)
        self.play(FadeIn(wrong, scale=1.4))
        self.say("That is worse than returning nothing, because the projected text looks completely credible.")
        self.say("The fix uses which occurrence was read, and the anchors around it. "
                 "When it still cannot tell, it omits the code. Omission, and a fresh read, remain necessary outcomes.")
        self.play(FadeOut(wrong), match.animate.set_color(GREY_D), Create(SurroundingRectangle(a, color=FRESH, buff=0.06)))
        self.clear_all()


class S5Budget(Base):
    def construct(self):
        self.chapter("4", "Selecting what fits")
        scale = 0.011
        bar = Rectangle(width=900 * scale, height=0.6, color=GREY_B).move_to(DOWN * 1.6)
        bar_lbl = label("900 bytes", size=22, color=MUTED, font=MONO).next_to(bar, DOWN, buff=0.2)
        units = [
            ("price.js · total", 76, FRESH, None),
            ("cart.py · apply", 310, BLUE_C, None),
            ("cart.py", 540, PURPLE_B, "overlap"),
            ("util.go · Parse", 620, GOLD_B, "too big"),
            ("rate.rs · region", 120, TEAL_E, None),
        ]
        blocks = VGroup()
        for name, size, color, _ in units:
            r = Rectangle(width=size * scale, height=0.45, color=color, fill_color=color, fill_opacity=0.35)
            t = label(name, size=18, font=MONO, color=GREY_A).next_to(r, UP, buff=0.06, aligned_edge=LEFT)
            blocks.add(VGroup(r, t))
        blocks.arrange(DOWN, aligned_edge=LEFT, buff=0.16)
        blocks.move_to([bar.get_left()[0] + blocks.width / 2, 3.5 - blocks.height / 2, 0])
        recent = Arrow(blocks.get_corner(DL) + LEFT * 0.4, blocks.get_corner(UL) + LEFT * 0.4, buff=0, color=MUTED)
        recent_lbl = label("recent", size=18, color=MUTED).rotate(PI / 2).next_to(recent, LEFT, buff=0.1)
        self.say("Every resolved unit competes for a fixed byte budget.")
        self.play(Create(bar), FadeIn(bar_lbl))
        self.play(LaggedStart(*[FadeIn(b) for b in blocks], lag_ratio=0.15))
        self.say("The policy is simple. Sort by most recent observation. Skip anything that overlaps. Admit what fits.")
        self.play(GrowArrow(recent), FadeIn(recent_lbl))
        x = bar.get_left()[0]
        for (name, size, color, reason), blk in zip(units, blocks):
            if reason is None:
                target = blk[0].copy().stretch_to_fit_height(0.6)
                target.move_to([x + target.width / 2, bar.get_y(), 0])
                self.play(TransformFromCopy(blk[0], target), run_time=0.7)
                x += target.width
            else:
                note = label(reason, size=18, color=OLD).next_to(blk[0], RIGHT, buff=0.25)
                self.play(blk.animate.set_opacity(0.25), FadeIn(note), run_time=0.7)
        self.say("A function is never cut short just to fill the last few bytes.")
        self.say("There is no learned relevance score here, no dependency graph, no embeddings. "
                 "That makes it easy to inspect. But a function can arrive without the import or caller that mattered.")
        self.say("And the budget counts projection bytes. It is not a token limit, and not a cost estimate.")
        self.clear_all()


class S6FailClosed(Base):
    def construct(self):
        self.chapter("5", "Failing as a unit")
        env = card(label("request", size=30, weight=BOLD), color=FRESH, pad=0.45).move_to(LEFT * 3.8 + UP * 0.8)
        disk = card(code_block(price_lines(20), size=24, t2c={"20": NEW}, spacing=0.4), "price.js", pad=0.3).move_to(RIGHT * 3.3 + UP * 0.8)
        self.say("Before anything is sent, the bridge checks the whole plan: "
                 "every replacement hash, the projection hash, the budget, and that every call still has its result.")
        self.play(FadeIn(env))
        checks = VGroup(*[label("✓", size=34, color=NEW) for _ in range(4)]).arrange(RIGHT, buff=0.35).next_to(env, DOWN, buff=0.4)
        self.play(LaggedStart(*[FadeIn(c, scale=1.3) for c in checks], lag_ratio=0.3))
        self.say("It also refuses a successful read that has no observation. "
                 "Otherwise, if the engine lost its state, an old read could slip back in as ordinary text.")
        self.play(FadeIn(disk))
        arr = DoubleArrow(env.get_right(), disk.get_left(), buff=0.2, color=HI)
        self.say("Then comes commit. The engine rereads the selected files, and compares them with the revisions it used to prepare.")
        self.play(GrowArrow(arr))
        num = disk[1][1].part("20")
        num2 = Text("25", font=MONO, font_size=24, color=OLD).move_to(num)
        self.say("If one changed in between, the host must throw that request away.")
        self.play(Transform(num, num2), Flash(num2, color=OLD))
        cross = Cross(env[0], stroke_color=OLD, stroke_width=6).set_z_index(2)
        self.play(Create(cross), FadeOut(checks))
        self.say("This is an optimistic check. It is not an atomic snapshot, and it does not lock the workspace. "
                 "Stronger guarantees have to come from the host.")
        self.say("It depends on the host in other ways too. Pi catches errors thrown by extensions, so throwing was not enough. "
                 "The bridge has to abort the turn, and tests confirm the request never reaches the provider.")
        self.clear_all()

        left = card(VGroup(label("invalid plan", size=28, weight=BOLD, color=OLD),
                           label("nothing is sent", size=22, color=GREY_A)).arrange(DOWN, buff=0.3), color=OLD, pad=0.45)
        right = card(VGroup(label("valid plan", size=28, weight=BOLD, color=GOLD_B),
                            label("[unit unavailable]", size=22, font=MONO, color=GREY_A)).arrange(DOWN, buff=0.3), color=GOLD_B, pad=0.45)
        VGroup(left, right).arrange(RIGHT, buff=1.2).move_to(UP * 0.4)
        self.say("Keep two cases apart. An invalid plan stops the request.")
        self.play(FadeIn(left))
        self.say("A valid plan can still omit code that was deleted, ambiguous, or too large. "
                 "It leaves an unavailable marker, and the request goes out.")
        self.play(FadeIn(right))
        self.clear_all()


class S7Evidence(Base):
    def construct(self):
        self.chapter("6", "What was measured")
        data = [
            ("Express", 1075, 1778),
            ("Flask as_view", 2715, 7111),
            ("Flask view", 829, 7120),
            ("Go tools", 1425, 6034),
            ("ripgrep", 2460, 14658),
        ]
        scale = 8.0 / 14658
        rows = VGroup()
        for i, (name, narrow, whole) in enumerate(data):
            y = 2.7 - i * 0.85
            nm = label(name, size=22, color=GREY_A)
            nm.move_to([-3.4 - nm.width / 2, y, 0])
            wb = Rectangle(width=whole * scale, height=0.28, stroke_width=0, fill_color=GREY_C, fill_opacity=0.8)
            nb = Rectangle(width=narrow * scale, height=0.28, stroke_width=0, fill_color=FRESH, fill_opacity=0.95)
            wb.move_to([-3.0 + wb.width / 2, y + 0.16, 0])
            nb.move_to([-3.0 + nb.width / 2, y - 0.16, 0])
            rows.add(VGroup(nm, wb, nb))
        legend = VGroup(
            VGroup(Square(0.2, fill_color=FRESH, fill_opacity=1, stroke_width=0), label("unit", size=20)).arrange(RIGHT, buff=0.12),
            VGroup(Square(0.2, fill_color=GREY_C, fill_opacity=1, stroke_width=0), label("whole file", size=20)).arrange(RIGHT, buff=0.12),
        ).arrange(RIGHT, buff=0.5).move_to(UP * 3.45 + RIGHT * 3.6)
        self.say("The first prototype was measured on five fixed traces, from Express, Flask, Go tools and ripgrep.")
        self.play(LaggedStart(*[FadeIn(r[0]) for r in rows], lag_ratio=0.1))
        self.say("Each compared a narrow unit of code against the whole file it came from.")
        self.play(FadeIn(legend), LaggedStart(*[AnimationGroup(GrowFromEdge(r[1], LEFT), GrowFromEdge(r[2], LEFT)) for r in rows], lag_ratio=0.2), run_time=2)
        total = label("−76.8%", size=64, weight=BOLD, color=HI).move_to(LEFT * 1.2 + DOWN * 1.7)
        detail = label("8,504 vs 36,701 bytes", size=22, color=MUTED, font=MONO).next_to(total, RIGHT, buff=0.6)
        self.say("In total, seventy-six point eight percent fewer bytes. And all five checks for required code passed.")
        self.play(Write(total), FadeIn(detail))
        self.say("But be precise about what that means. These are bytes of message text, not billed tokens. "
                 "No model solved a task in this experiment. It says nothing about dollars.")
        self.clear_all()

        self.say("Then came a small live pilot. The Pi agent, with DeepSeek V4 Flash. "
                 "Five tasks, each run once without FreshCtx, and once with it.",
                 spoken="Then came a small live pilot. The Pi agent, with Deep Seek V4 Flash. "
                        "Five tasks, each run once without Fresh Context, and once with it.")

        def dots(results):
            return VGroup(*[Circle(radius=0.28, stroke_width=3, color=NEW if r else OLD).set_fill(NEW if r else OLD, 0.35 if r else 0.15)
                            for r in results]).arrange(RIGHT, buff=0.35)

        base = dots([True] * 5).move_to([0.6, 1.8, 0])
        fresh = dots([True, False, True, False, True]).move_to([0.6, 0.5, 0])
        base_l = label("baseline", size=26, color=GREY_A)
        fresh_l = label("FreshCtx", size=26, color=FRESH)
        base_l.move_to([-2.4 - base_l.width / 2, 1.8, 0])
        fresh_l.move_to([-2.4 - fresh_l.width / 2, 0.5, 0])
        score_b = label("5/5", size=30, weight=BOLD, color=NEW).next_to(base, RIGHT, buff=0.6)
        score_f = label("3/5", size=30, weight=BOLD, color=HI).next_to(fresh, RIGHT, buff=0.6)
        self.play(FadeIn(base_l), FadeIn(fresh_l))
        self.say("On the first resumed request, the baseline held old code in all five cases. FreshCtx held current code in all five.",
                 spoken="On the first resumed request, the baseline held old code in all five cases. Fresh Context held current code in all five.")
        self.say("And yet the baseline completed five out of five tasks. FreshCtx completed three.",
                 spoken="And yet, the baseline completed five out of five tasks. Fresh Context completed three.")
        self.play(LaggedStart(*[GrowFromCenter(d) for d in base], lag_ratio=0.1), FadeIn(score_b))
        self.play(LaggedStart(*[GrowFromCenter(d) for d in fresh], lag_ratio=0.1), FadeIn(score_f))
        self.say("The two failures ran out their eight-request cap. The baseline could simply reread the file, "
                 "so stale context never forced a wrong answer.")
        self.play(Indicate(fresh[1], color=OLD), Indicate(fresh[3], color=OLD))
        self.say("It is five paired runs. And the treatment also changed how code was presented, "
                 "so it cannot isolate the effect of freshness.")
        self.clear_all()

        a = label("current bytes", size=36, weight=BOLD, color=FRESH)
        b = label("finished task", size=36, weight=BOLD, color=HI)
        neq = label("≠", size=72)
        VGroup(a, neq, b).arrange(RIGHT, buff=0.7).move_to(UP * 0.4)
        self.say("That is the central lesson. Delivering current bytes, and completing the task, are different properties.")
        self.play(FadeIn(a, shift=0.2 * RIGHT))
        self.play(Write(neq))
        self.play(FadeIn(b, shift=0.2 * LEFT))
        self.say("The first can be checked at the request boundary. "
                 "The second depends on what the model does with that request.")
        self.play(Indicate(a, color=FRESH))
        self.play(Indicate(b, color=HI))
        self.say("A later check did confirm freshness on the real path: the provider received target rate twelve, with no reread. "
                 "Without FreshCtx, it still saw ten. That is freshness. Not better performance.",
                 spoken="A later check did confirm freshness on the real path: the provider received target rate twelve, with no reread. "
                        "Without Fresh Context, it still saw ten. That is freshness. Not better performance.")
        self.clear_all()


class S8Close(Base):
    def construct(self):
        self.chapter("7", "Differences and limits")
        cols = [("read again", "the model decides", BLUE_B), ("compact", "facts go stale", GOLD_B),
                ("CORVUS", "whole files", PURPLE_B), ("FreshCtx", "functions, regions", FRESH)]
        cards = VGroup()
        for name, desc, color in cols:
            inner = VGroup(label(name, size=28, weight=BOLD, color=color), label(desc, size=20, color=GREY_A)).arrange(DOWN, buff=0.35)
            box = RoundedRectangle(corner_radius=0.12, width=3.1, height=2.0, color=color, stroke_width=2).set_fill(PANEL, 1).set_z_index(-1)
            cards.add(VGroup(box, inner.move_to(box)))
        cards.arrange(RIGHT, buff=0.3).move_to(UP * 0.6)
        self.play(LaggedStart(*[FadeIn(c, shift=0.1 * UP) for c in cards[:2]], lag_ratio=0.3))
        self.say("FreshCtx follows a direction explored by CORVUS, which registers files and refreshes their contents.",
                 spoken="Fresh Context follows a direction explored by Corvus, which registers files and refreshes their contents.")
        self.play(FadeIn(cards[2], shift=0.1 * UP))
        self.say("FreshCtx explores a narrower unit: a function, or a region, when it can identify one.",
                 spoken="Fresh Context explores a narrower unit: a function, or a region, when it can identify one.")
        self.play(FadeIn(cards[3], shift=0.1 * UP))
        self.clear_all()

        summary = card(label("“total × 10”", size=28, color=OLD), "assistant", color=GREY_D, pad=0.3, title_size=18).move_to(UP * 0.5)
        self.say("And it leaves a lot untouched. It does not refresh an assistant's earlier explanation, or a compaction summary. "
                 "Refreshing a function does not retract a conclusion drawn from it.")
        self.play(FadeIn(summary))
        self.play(Indicate(summary, color=OLD))
        self.say("That is a separate problem, and a good reason to keep the claims narrow.")
        self.clear_all()

        nexts = VGroup(
            label("vary only freshness", size=28),
            label("compare units where dependencies matter", size=28),
            label("measure tokens, cache, latency, outcomes together", size=28),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.5).move_to(UP * 0.5)
        nums = VGroup(*[label(str(i + 1), size=28, color=HI, font=MONO).next_to(n, LEFT, buff=0.4) for i, n in enumerate(nexts)])
        self.say("Three experiments would make the evidence more useful.")
        for num, text, speech in zip(nums, nexts, [
            "Hold the format and instructions fixed, and vary only whether code is refreshed.",
            "Compare regions, symbols and whole files on tasks where dependencies matter.",
            "And measure full requests, tokens, caching, latency and outcomes, together.",
        ]):
            self.say(speech)
            self.play(FadeIn(num), FadeIn(text, shift=0.1 * RIGHT))
        self.clear_all()

        line = Line(UP * 2.6, DOWN * 2.2, color=HI, stroke_width=4)
        left = VGroup(label("recorded history", size=28, color=GREY_A),
                      label("quantity * 10", size=26, font=MONO, color=OLD)).arrange(DOWN, buff=0.4).move_to(LEFT * 3.4 + UP * 0.2)
        right = VGroup(label("what the model sees", size=28, color=FRESH),
                       label("quantity * 20", size=26, font=MONO, color=NEW)).arrange(DOWN, buff=0.4).move_to(RIGHT * 3.4 + UP * 0.2)
        self.say("This started with one old tool result and one changed file.")
        self.play(Create(line))
        self.say("What came out of it is an explicit boundary. Recorded history on one side. "
                 "The current source a model sees, on the other.")
        self.play(FadeIn(left, shift=0.2 * RIGHT))
        self.play(FadeIn(right, shift=0.2 * LEFT))
        self.say("A boundary you can inspect, change, and measure.", pause=1.2)
        self.clear_all()
        brand = label("FreshCtx", size=60, weight=BOLD, color=FRESH)
        site = label("felipebasurto.com", size=24, color=MUTED).next_to(brand, DOWN, buff=0.4)
        self.play(Write(brand), FadeIn(site))
        self.wait(3)
        self.play(FadeOut(brand), FadeOut(site))


SCENES = ["S1Hook", "S2Cache", "S3Pipeline", "S4Identity", "S5Budget", "S6FailClosed", "S7Evidence", "S8Close"]
