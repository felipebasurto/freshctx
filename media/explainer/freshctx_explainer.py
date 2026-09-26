import os
import textwrap

from manim import *

LANG = os.environ.get("FRESHCTX_LANG", "es")


def T(es, en):
    return es if LANG == "es" else en


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


def price_lines(multiplier):
    return ["function total(quantity) {", f"  return quantity * {multiplier};", "}"]


class Base(Scene):
    def setup(self):
        self.caption = None
        self.caption_until = 0.0

    def now(self):
        return self.renderer.time

    def settle(self):
        remaining = self.caption_until - self.now()
        if remaining > 0.02:
            self.wait(remaining)

    def say(self, text, extra=0.0):
        self.settle()
        wrapped = "\n".join(textwrap.wrap(text, 74))
        words = Text(wrapped, font=SANS, font_size=25, color=WHITE, line_spacing=0.9)
        if words.width > 12.6:
            words.scale_to_fit_width(12.6)
        words.to_edge(DOWN, buff=0.32)
        shade = BackgroundRectangle(words, color=BG, fill_opacity=0.85, buff=0.12)
        new = VGroup(shade, words)
        animations = [FadeIn(new, shift=0.08 * UP)]
        if self.caption is not None:
            animations.append(FadeOut(self.caption))
        self.play(*animations, run_time=0.35)
        self.caption = new
        self.caption_until = self.now() + 0.9 + 0.34 * len(text.split()) + extra

    def unsay(self):
        self.settle()
        if self.caption is not None:
            self.play(FadeOut(self.caption), run_time=0.3)
            self.caption = None

    def clear_all(self, run_time=0.6):
        self.settle()
        keep = [self.caption] if self.caption is not None else []
        others = [m for m in self.mobjects if m not in keep]
        animations = [FadeOut(m) for m in others]
        if self.caption is not None:
            animations.append(FadeOut(self.caption))
            self.caption = None
        if animations:
            self.play(*animations, run_time=run_time)

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
        title = label(T("El contexto del modelo no es estático", "Model context is not static"), size=46, weight=BOLD)
        sub = label(T("Cómo FreshCtx mantiene al día el código que ve un agente",
                      "How FreshCtx keeps an agent's view of code current"), size=26, color=MUTED)
        sub.next_to(title, DOWN, buff=0.35)
        self.play(Write(title), run_time=1.6)
        self.play(FadeIn(sub, shift=0.1 * UP))
        self.wait(1.6)
        self.play(FadeOut(title), FadeOut(sub))

        disk_code = code_block(price_lines(10), t2c={"10": HI})
        disk = card(disk_code, "disk · price.js")
        disk.move_to(RIGHT * 3.6 + UP * 0.9)
        disk_title = label(T("Disco", "Disk"), size=30, weight=BOLD).next_to(disk, UP, buff=0.55)

        convo_title = label(T("Conversación", "Conversation"), size=30, weight=BOLD)
        convo_title.move_to(LEFT * 3.6 + UP * 3.0)
        disk_title.match_y(convo_title)
        divider = DashedLine(UP * 3.4, DOWN * 2.3, color=GREY_D)

        user_msg = card(label(T("usuario: ¿qué devuelve total(3)?", "user: what does total(3) return?"), size=20), fill="#222733")
        user_msg.move_to(LEFT * 3.6 + UP * 2.1)

        self.play(FadeIn(convo_title), FadeIn(disk_title), Create(divider))
        self.play(FadeIn(disk, shift=0.2 * LEFT))
        self.say(T("Un agente de programación lee una función de un archivo.",
                   "A coding agent reads a function from a file."))
        self.play(FadeIn(user_msg, shift=0.2 * DOWN))

        read_code = code_block(price_lines(10), t2c={"10": HI}, size=20)
        read = card(read_code, "tool result · read-1", color=BLUE_D)
        read.next_to(user_msg, DOWN, buff=0.6)
        ghost = disk_code.copy()
        self.play(ReplacementTransform(ghost, read_code), FadeIn(read[0]), FadeIn(read[2]), run_time=1.3)

        self.say(T("Esa lectura queda guardada en la conversación como resultado de una herramienta.",
                   "That read is stored in the conversation as a tool result."))

        self.say(T("Después, alguien cambia el multiplicador a 20.", "Then someone changes the multiplier to 20."))
        old_num = disk_code[1].part("10")
        new_num = Text("20", font=MONO, font_size=22, color=NEW).move_to(old_num)
        self.play(Indicate(old_num, color=HI))
        self.play(Transform(old_num, new_num), Flash(new_num, color=NEW, flash_radius=0.4))

        self.say(T("El agente sigue trabajando. ¿Qué código verá el modelo en su próxima llamada?",
                   "The agent keeps working. What code does the model see on its next call?"))
        model = card(label(T("modelo", "model"), size=26, weight=BOLD), color=PURPLE_B, pad=0.3)
        model.move_to(LEFT * 3.6 + DOWN * 1.6)
        arrow = Arrow(read.get_bottom(), model.get_top(), buff=0.1, color=PURPLE_B)
        self.play(FadeIn(model), GrowArrow(arrow))
        self.play(Indicate(read_code[1].part("10"), color=OLD, scale_factor=1.5))

        self.say(T("El archivo en disco dice 20. El resultado antiguo todavía dice 10.",
                   "The file on disk says 20. The old tool result still says 10."))
        old_mark = SurroundingRectangle(read_code[1].part("10"), color=OLD, buff=0.06)
        new_mark = SurroundingRectangle(disk_code[1].part("10"), color=NEW, buff=0.06)
        self.play(Create(old_mark), Create(new_mark))

        self.say(T("Las herramientas operan sobre el archivo actual, pero el modelo razona sobre el viejo.",
                   "The tools operate on the current file, but the model reasons from the old one."))
        tools = label(T("herramientas → 20", "tools → 20"), size=22, color=NEW).next_to(disk, DOWN, buff=0.5)
        reason = label(T("modelo → 10", "model → 10"), size=22, color=OLD).next_to(model, RIGHT, buff=0.4)
        self.play(FadeIn(tools), FadeIn(reason))

        self.say(T("El agente puede volver a leer el archivo, y a menudo lo hace. Pero entonces la frescura depende de que el modelo decida repetir la lectura.",
                   "The agent can read the file again, and often does. But then freshness depends on the model deciding to repeat a tool call."), extra=0.5)
        self.say(T("¿Y si fuera el software que mantiene la conversación quien se encargara de refrescar el código? Esa pregunta es FreshCtx.",
                   "What if the software that maintains the conversation took responsibility for refreshing code instead? That question became FreshCtx."), extra=0.5)
        self.clear_all()


class S2Cache(Base):
    def construct(self):
        self.chapter("1", T("Una conversación también es una caché", "A conversation is also a cache"))

        harness = card(label("harness", size=24, weight=BOLD), color=BLUE_C, pad=0.3).move_to(LEFT * 4.8 + UP * 0.6)
        model = card(label(T("modelo", "model"), size=24, weight=BOLD), color=PURPLE_B, pad=0.3).move_to(RIGHT * 4.8 + UP * 0.6)
        names = [T("sistema", "system"), T("usuario", "user"), "read-1 · price.js", T("asistente", "assistant"), T("usuario", "user")]
        colors = [GREY_D, GREY_D, BLUE_D, GREY_D, GREY_D]
        msgs = VGroup()
        for n, c in zip(names, colors):
            t = label(n, size=18, font=MONO)
            r = RoundedRectangle(corner_radius=0.1, width=3.4, height=0.5, color=c, stroke_width=2).set_fill(PANEL, 1).set_z_index(-1)
            msgs.add(VGroup(r, t.move_to(r)))
        msgs.arrange(DOWN, buff=0.12).move_to(UP * 0.6)
        brace = Brace(msgs, RIGHT, color=GREY_B)
        request = label(T("petición", "request"), size=20, color=GREY_B).next_to(brace, RIGHT, buff=0.1)
        self.say(T("Un agente combina un modelo de lenguaje con un harness: el programa que ejecuta herramientas, guarda sus resultados y construye la siguiente petición.",
                   "An agent combines a language model with a harness: the program that runs tools, records their results, and builds the next model request."), extra=0.5)
        self.play(FadeIn(harness), FadeIn(model))
        self.play(LaggedStart(*[FadeIn(m, shift=0.15 * RIGHT) for m in msgs], lag_ratio=0.15), run_time=1.4)
        self.play(GrowFromCenter(brace), FadeIn(request))
        a1 = Arrow(harness.get_right(), msgs.get_left(), buff=0.15, color=BLUE_C)
        a2 = Arrow(request.get_right(), model.get_left(), buff=0.15, color=PURPLE_B)
        self.play(GrowArrow(a1), GrowArrow(a2))
        self.say(T("El modelo solo ve los mensajes de esa petición. No ve automáticamente un cambio posterior en un archivo que se leyó antes.",
                   "The model sees only the messages in that request. It does not automatically see a later edit to a file read earlier."), extra=0.4)
        self.play(Indicate(msgs[2], color=BLUE_C))
        self.clear_all()

        result = card(code_block(price_lines(10), t2c={"10": HI}, size=20), "tool result · read-1", color=BLUE_D).move_to(LEFT * 4.9 + UP * 1.0)
        job1 = label(T("1 · registro: qué devolvió la herramienta en t₀", "1 · record: what a tool returned at t₀"), size=20)
        job2 = label(T("2 · código fuente para razonar después", "2 · source code for future reasoning"), size=20)
        jobs = VGroup(job1, job2).arrange(DOWN, aligned_edge=LEFT, buff=0.5)
        jobs.move_to([-1.2 + jobs.width / 2, 1.0, 0])
        self.say(T("Un resultado de lectura tiene dos trabajos a la vez.", "A file-read result has two jobs at once."))
        self.play(FadeIn(result))
        self.play(FadeIn(job1, shift=0.1 * LEFT))
        self.play(FadeIn(job2, shift=0.1 * LEFT))
        ok1 = label("✓", size=30, color=NEW).next_to(job1, LEFT, buff=0.25)
        ok2 = label("✓", size=30, color=NEW).next_to(job2, LEFT, buff=0.25)
        self.play(FadeIn(ok1), FadeIn(ok2))
        self.say(T("Ambos coinciden… hasta que el archivo cambia.", "Both agree… until the file changes."))
        change = label(T("price.js cambia: 10 → 20", "price.js changes: 10 → 20"), size=22, color=HI).next_to(result, DOWN, buff=0.4)
        self.play(FadeIn(change, shift=0.1 * UP))
        bad2 = label("✗", size=30, color=OLD).move_to(ok2)
        self.play(Transform(ok2, bad2), job2.animate.set_color(OLD))
        self.say(T("Como historia sigue siendo correcto. Como código actual, ya no lo es.",
                   "As history it is still correct. As current source, it no longer is."))
        self.clear_all()

        self.say(T("Hay varias salidas habituales. Cada una tiene su problema.", "There are a few common ways out. Each has a problem."))
        headers = [T("volver a leer", "read again"), T("resumir / compactar", "summarize / compact"), "FreshCtx"]
        columns = VGroup()
        for i, h in enumerate(headers):
            head = label(h, size=24, weight=BOLD, color=[BLUE_B, GOLD_B, FRESH][i])
            columns.add(head)
        columns.arrange(RIGHT, buff=2.2).to_edge(UP, buff=0.5)
        for i in range(3):
            columns[i].move_to([-4.5 + 4.5 * i, 3.2, 0])

        def mini(num, color=GREY_D, title="read"):
            return card(label(f"quantity * {num}", size=17, font=MONO, color={10: OLD, 20: NEW}.get(num, WHITE)), title, color=color, pad=0.14, title_size=14)

        r1 = mini(10, title="read-1").move_to([-4.5, 2.0, 0])
        r2 = mini(20, title="read-2").move_to([-4.5, 0.8, 0])
        self.play(FadeIn(columns[0]), FadeIn(r1))
        self.play(FadeIn(r2, shift=0.1 * DOWN))
        n1 = label(T("dos versiones conviven;\nel modelo decide cuál vale", "two versions coexist;\nthe model decides which counts"), size=17, color=MUTED).next_to(r2, DOWN, buff=0.35)
        self.play(FadeIn(n1))
        self.say(T("Volver a leer añade otra versión. Cada una fue correcta en su momento, y todas acaban en el contexto.",
                   "Reading again adds another version. Each was correct at a different moment, and all of them end up in context."), extra=0.3)

        summary = card(label(T("«total multiplica por 10»", "\"total multiplies by 10\""), size=17, color=OLD), T("resumen", "summary"), color=GOLD_D, pad=0.16, title_size=14).move_to([0, 1.4, 0])
        s_src = VGroup(mini(10, title="read-1"), mini(10, title="…")).arrange(DOWN, buff=0.35).move_to([0, 1.4, 0])
        self.play(FadeIn(columns[1]), FadeIn(s_src))
        self.play(ReplacementTransform(s_src, summary))
        n2 = label(T("el hecho obsoleto sobrevive\naunque su fuente ya no exista", "the obsolete fact survives\nafter its source is gone"), size=17, color=MUTED).next_to(summary, DOWN, buff=0.55)
        self.play(FadeIn(n2))
        self.say(T("Compactar la historia en un resumen puede conservar un hecho obsoleto después de que desaparezca la fuente que lo justificaba.",
                   "Compressing history into a summary can preserve an obsolete fact after the source that justified it has disappeared."), extra=0.3)

        saved = mini(10, title=T("historial guardado", "saved history"), color=GREY_C).move_to([4.5, 2.0, 0])
        out = VGroup(
            card(label("[a2bc5d45…]", size=16, font=MONO, color=MUTED), T("marcador", "marker"), color=GREY_D, pad=0.12, title_size=14),
            mini(20, title=T("vista actual", "current view"), color=FRESH),
        ).arrange(DOWN, buff=0.35).move_to([4.5, 0.2, 0])
        self.play(FadeIn(columns[2]), FadeIn(saved))
        copy_arrow = Arrow(saved.get_bottom(), out.get_top(), buff=0.12, color=FRESH)
        copy_lbl = label(T("copia saliente", "outgoing copy"), size=15, color=FRESH).next_to(copy_arrow, RIGHT, buff=0.1)
        self.play(GrowArrow(copy_arrow), FadeIn(copy_lbl), FadeIn(out, shift=0.1 * DOWN))
        self.say(T("FreshCtx separa los dos trabajos: la historia guardada no se toca, y solo se reescribe la copia que sale hacia el modelo.",
                   "FreshCtx separates the two jobs: saved history is untouched, and only the copy sent to the model is rewritten."), extra=0.5)
        self.clear_all()


class S3Pipeline(Base):
    def construct(self):
        self.chapter("2", T("De una lectura a la siguiente petición", "From one read to the next request"))

        agent = card(label(T("agente (host)", "agent (host)"), size=24, weight=BOLD), color=BLUE_C, pad=0.3).move_to(LEFT * 4.6 + UP * 2.6)
        bridge = card(label("bridge", size=22, font=MONO), color=BLUE_D, pad=0.25).next_to(agent, DOWN, buff=0.35)
        engine = card(label(T("FreshCtx (proceso local)", "FreshCtx (local process)"), size=24, weight=BOLD), color=FRESH, pad=0.3)
        engine.move_to([3.6, bridge.get_y(), 0])
        link = DoubleArrow(bridge.get_right(), engine.get_left(), buff=0.15, color=GREY_B)
        jsonl = label("JSONL · stdin / stdout", size=18, font=MONO, color=MUTED).next_to(link, UP, buff=0.15)
        self.say(T("FreshCtx es un proceso de Node persistente que corre al lado del agente. Un bridge lo conecta con el lector de archivos y con el último gancho antes de enviar la petición.",
                   "FreshCtx is a persistent Node process running beside the agent. A bridge connects it to the host's reader and to its final request hook."), extra=0.5)
        self.play(FadeIn(agent), FadeIn(bridge))
        self.play(FadeIn(engine), GrowArrow(link), FadeIn(jsonl))
        no_llm = label(T("no llama a ningún proveedor de modelos", "never calls a model provider"), size=18, color=MUTED).next_to(engine, DOWN, buff=0.2)
        self.play(FadeIn(no_llm))
        self.say(T("Hablan con JSON delimitado por líneas. El motor nunca llama al proveedor del modelo.",
                   "They exchange newline-delimited JSON. The engine never calls a model provider."))

        steps = [T("Observar", "Observe"), T("Preparar", "Prepare"), T("Validar y aplicar", "Validate & apply"), T("Confirmar", "Commit")]
        chips = VGroup(*[card(label(s, size=21, weight=BOLD), color=GREY_C, pad=0.18) for s in steps]).arrange(RIGHT, buff=0.55)
        chips.move_to(DOWN * 0.9)
        arrows = VGroup(*[Arrow(chips[i].get_right(), chips[i + 1].get_left(), buff=0.06, color=GREY_B, max_tip_length_to_length_ratio=0.3) for i in range(3)])
        self.play(LaggedStart(*[FadeIn(c, shift=0.1 * UP) for c in chips], lag_ratio=0.2), Create(arrows))
        details = [
            T("guardar los bytes exactos que devolvió una lectura", "record the exact bytes a successful read returned"),
            T("localizar ese código en el workspace actual y proponer la reescritura", "find that code in the current workspace and propose a rewrite"),
            T("comprobar el plan contra los resultados reales y reescribir una copia", "check the plan against the real tool results, rewrite a copy"),
            T("releer los archivos elegidos antes de dejar salir la copia", "recheck selected files before the copy may be dispatched"),
        ]
        detail = None
        for i, d in enumerate(details):
            new = label(d, size=20, color=HI).next_to(chips, DOWN, buff=0.45)
            anims = [chips[i][0].animate.set_stroke(HI, width=3)]
            if i:
                anims.append(chips[i - 1][0].animate.set_stroke(GREY_C, width=2))
            if detail is None:
                anims.append(FadeIn(new))
            else:
                anims.extend([FadeOut(detail, shift=0.1 * UP), FadeIn(new, shift=0.1 * UP)])
            self.play(*anims, run_time=0.6)
            detail = new
            self.wait(1.8)
        self.say(T("Cuatro pasos. Veámoslos con el ejemplo de total().", "Four steps. Let's walk through them with total()."))
        self.clear_all()

        code = code_block(price_lines(10), t2c={"10": HI})
        file_card = card(code, "price.js", pad=0.3).move_to(LEFT * 3.7 + UP * 1.6)
        self.play(FadeIn(file_card))
        box = SurroundingRectangle(code, color=HI, buff=0.12)
        rng = label("range: [0, 52)  · UTF-8 bytes", size=20, font=MONO, color=HI).next_to(file_card, DOWN, buff=0.3)
        self.play(Create(box), FadeIn(rng))
        observe = code_block([
            '{ "op": "observe",',
            '  "result_id": "read-1",',
            '  "path": "price.js",',
            '  "range": { "start_byte": 0,',
            '             "end_byte": 52 },',
            '  "content_utf8_base64": "…" }',
        ], size=18, t2c={'"observe"': FRESH, '"read-1"': BLUE_B, "52": HI, " 0": HI})
        obs = card(observe, T("el bridge avisa a FreshCtx", "the bridge tells FreshCtx"), color=FRESH).move_to(RIGHT * 3.3 + UP * 1.6)
        self.say(T("Observar: cuando una lectura tiene éxito, el bridge le dice a FreshCtx de dónde salieron exactamente esos bytes.",
                   "Observe: when a read succeeds, the bridge tells FreshCtx exactly where those bytes came from."), extra=0.3)
        self.play(FadeIn(obs, shift=0.2 * LEFT))
        self.say(T("El rango se mide en bytes UTF-8, sin incluir el final. Un emoji ocupa varios bytes, y los números de línea añadidos para mostrar no son bytes del código.",
                   "The range is zero-based, end-exclusive UTF-8 bytes. An emoji takes several bytes, and display line numbers are not source bytes."), extra=0.4)

        ids = VGroup(
            VGroup(label("result_id", size=20, font=MONO, color=BLUE_B), label(T("ata el plan a un mensaje", "ties a plan to a message"), size=18)),
            VGroup(label("unit", size=20, font=MONO, color=FRESH), label(T("identifica el código seguido", "identifies the tracked code"), size=18)),
            VGroup(label("revision", size=20, font=MONO, color=HI), label(T("SHA-256 de unos bytes concretos", "SHA-256 of particular bytes"), size=18)),
        )
        for g in ids:
            g.arrange(RIGHT, buff=0.3, aligned_edge=DOWN)
        ids.arrange(DOWN, aligned_edge=LEFT, buff=0.3).move_to(DOWN * 1.3)
        self.say(T("FreshCtx guarda tres identidades distintas, y no hay que confundirlas.",
                   "FreshCtx keeps three different identities, and they must not be confused."))
        self.play(LaggedStart(*[FadeIn(g, shift=0.1 * RIGHT) for g in ids], lag_ratio=0.4), run_time=1.8)
        self.clear_all()

        saved_title = label(T("historial guardado", "saved history"), size=24, weight=BOLD).move_to(LEFT * 3.7 + UP * 3.2)
        out_title = label(T("copia saliente", "outgoing copy"), size=24, weight=BOLD, color=FRESH).move_to(RIGHT * 3.3 + UP * 3.2)
        div = DashedLine(UP * 3.5, DOWN * 2.3, color=GREY_D)

        def history(tool_content):
            items = VGroup(
                card(label(T("asistente → read(price.js)", "assistant → read(price.js)"), size=16, font=MONO), pad=0.12),
                tool_content,
                card(label(T("usuario: ¿qué devuelve total(3)?", "user: what does total(3) return?"), size=16), pad=0.12),
            ).arrange(DOWN, buff=0.18, aligned_edge=LEFT)
            return items

        saved_tool = card(code_block(price_lines(10), size=17, t2c={"10": OLD}, spacing=0.3), "tool · read-1", color=BLUE_D, pad=0.14, title_size=14)
        saved = history(saved_tool).next_to(saved_title, DOWN, buff=0.35)
        out_tool = card(code_block(price_lines(10), size=17, t2c={"10": OLD}, spacing=0.3), "tool · read-1", color=BLUE_D, pad=0.14, title_size=14)
        out = history(out_tool).next_to(out_title, DOWN, buff=0.35)
        self.play(FadeIn(saved_title), FadeIn(saved), Create(div))
        self.say(T("Preparar y aplicar: tras el cambio, el bridge copia la petición que está a punto de enviar.",
                   "Prepare and apply: after the edit, the bridge copies the request it is about to send."))
        self.play(FadeIn(out_title), TransformFromCopy(saved, out), run_time=1.2)

        marker = card(label("[a2bc5d45e8a9b6375344a9f4]", size=15, font=MONO, color=MUTED), "tool · read-1", color=GREY_D, pad=0.14, title_size=14)
        marker.move_to(out_tool, aligned_edge=LEFT)
        self.say(T("En la copia, el resultado antiguo se sustituye por un marcador corto con el ID de la unidad. La llamada y su resultado siguen emparejados.",
                   "In the copy, the old result becomes a short unit marker. The tool call and its result stay paired."), extra=0.3)
        self.play(ReplacementTransform(out_tool, marker))
        out[1] = marker
        self.play(out[2].animate.next_to(marker, DOWN, buff=0.18, aligned_edge=LEFT))

        proj_code = code_block(["price.js:symbol:52bytes"] + price_lines(20), size=17, t2c={"20": NEW, "price.js:symbol:52bytes": FRESH}, spacing=0.3)
        proj = card(proj_code, T("usuario · proyección actual", "user · current projection"), color=FRESH, pad=0.14, title_size=14)
        proj.next_to(out[2], DOWN, buff=0.18, aligned_edge=LEFT)
        self.say(T("Y la vista actual del código se añade al final como un mensaje nuevo: la proyección.",
                   "And the current view of the code is appended as a new message: the projection."))
        self.play(FadeIn(proj, shift=0.1 * UP))
        sizes = label(T("cuerpo 52 bytes · proyección 76 bytes", "body 52 bytes · projection 76 bytes"), size=17, color=MUTED).next_to(proj, DOWN, buff=0.15)
        self.play(FadeIn(sizes))
        self.say(T("Fíjate: el historial guardado sigue diciendo 10. Nada se borra; solo cambia lo que viaja al modelo.",
                   "Notice: saved history still says 10. Nothing is erased; only what travels to the model changes."), extra=0.3)
        self.play(Indicate(saved_tool, color=OLD), Indicate(proj, color=NEW))
        self.say(T("Un detalle importante: solo cuentan las observaciones que siguen presentes en la petición. Si una compactación olvidó una lectura, no resucita en silencio.",
                   "One detail: only observations still present in the outgoing request count. If compaction forgot a read, it does not silently come back."), extra=0.5)
        self.say(T("Este ejemplo es ejecutable: npm run demo arranca el motor real, edita el archivo, comprueba los hashes y confirma la reescritura. Sin llamar a ningún LLM.",
                   "This example is executable: npm run demo starts the real engine, edits the file, checks hashes, and commits the rewrite. No LLM is called."), extra=0.5)
        self.clear_all()


class S4Identity(Base):
    def construct(self):
        self.chapter("3", T("¿Qué cuenta como «el mismo código»?", "What counts as the same code?"))
        self.say(T("Refrescar un archivo entero es fácil: guardas su ruta y lo vuelves a leer. Refrescar un trozo exige decidir qué es ese trozo después de que las ediciones lo muevan.",
                   "Refreshing a whole file is easy: keep its path and read it again. Refreshing a small part means deciding what that part is after edits move it."), extra=0.5)
        rows = [
            (T("Archivo", "File"), T("ruta relativa al workspace", "workspace-relative path"), NEW),
            (T("Símbolo", "Symbol"), T("selector único vía Tree-sitter", "unique selector via Tree-sitter"), FRESH),
            (T("Región", "Region"), T("bytes observados + anclas (heurística)", "observed bytes + anchors (heuristic)"), GOLD_B),
        ]
        table = VGroup()
        for i, (name, how, color) in enumerate(rows):
            y = 2.0 - i * 0.9
            name_m = label(name, size=26, weight=BOLD, color=color)
            name_m.move_to([-4.2 + name_m.width / 2, y, 0])
            how_m = label(how, size=22)
            how_m.move_to([-1.4 + how_m.width / 2, y, 0])
            table.add(VGroup(name_m, how_m))
        self.play(LaggedStart(*[FadeIn(r, shift=0.1 * RIGHT) for r in table], lag_ratio=0.4), run_time=1.8)
        self.say(T("FreshCtx usa tres tipos de unidad, cada una con su forma de reencontrarse.",
                   "FreshCtx uses three kinds of unit, each found again in its own way."))
        self.clear_all()

        lines = ["const TAX = 0.21;", "", "function total(quantity) {", "  return quantity * 20;", "}"]
        code = code_block(price_lines(20), t2c={"20": NEW})
        file_card = card(code, "price.js", pad=0.3).move_to(LEFT * 3.2 + UP * 1.2)
        offs = label("bytes [0, 52)", size=20, font=MONO, color=HI).next_to(file_card, DOWN, buff=0.3)
        tree = VGroup(
            label("program", size=18, font=MONO, color=MUTED),
            label("function_declaration", size=18, font=MONO, color=FRESH),
            label('name: "total"', size=18, font=MONO, color=HI),
        ).arrange(DOWN, buff=0.55).move_to(RIGHT * 3.6 + UP * 1.2)
        edges = VGroup(Line(tree[0].get_bottom(), tree[1].get_top(), buff=0.08, color=GREY_C), Line(tree[1].get_bottom(), tree[2].get_top(), buff=0.08, color=GREY_C))
        ts = label("Tree-sitter", size=20, color=MUTED).next_to(tree, UP, buff=0.3)
        self.play(FadeIn(file_card), FadeIn(offs))
        self.say(T("En Python, JavaScript, TypeScript, Go y Rust, Tree-sitter convierte un rango dentro de una función en un símbolo.",
                   "For Python, JavaScript, TypeScript, Go, and Rust, Tree-sitter turns a range inside a function into a symbol."))
        self.play(FadeIn(ts), FadeIn(tree), Create(edges))
        self.say(T("Si alguien inserta líneas encima, los offsets cambian… pero el selector no.",
                   "If someone inserts lines above, the offsets change… but the selector does not."))
        code2 = code_block(lines, t2c={"20": NEW, "const TAX = 0.21;": GOLD_B})
        file2 = card(code2, "price.js", pad=0.3).move_to(file_card.get_top(), aligned_edge=UP)
        offs2 = label("bytes [19, 71)", size=20, font=MONO, color=HI).next_to(file2, DOWN, buff=0.3)
        self.play(ReplacementTransform(file_card, file2), ReplacementTransform(offs, offs2), run_time=1.2)
        hl = SurroundingRectangle(VGroup(code2[2], code2[4]), color=FRESH, buff=0.08)
        self.play(Create(hl), Indicate(tree[2], color=FRESH))
        self.say(T("FreshCtx vuelve a encontrar la declaración y proyecta su cuerpo actual.",
                   "FreshCtx locates the declaration again and projects its current body."))
        self.say(T("Ojo: esto puede ensanchar la lectura. Una sola línea vista dentro de una función puede traer la función entera.",
                   "Careful: this can widen the read. One observed line inside a function may bring in the whole function."), extra=0.3)
        self.play(Indicate(code2[3], color=HI))
        self.say(T("Si el lenguaje no está soportado, el parseo falla o el símbolo se pierde, puede caer al archivo completo actual.",
                   "Unsupported languages, broken parses, or lost symbols may fall back to the current whole file."))
        region = SurroundingRectangle(code2[0], color=GOLD_B, buff=0.08)
        self.play(FadeOut(hl), Create(region))
        self.say(T("Algo como const TAX, fuera de cualquier función, queda como región: se guardan bytes vecinos como anclas y se busca el tramo tras las ediciones. Es una identidad heurística.",
                   "Something like const TAX, outside any function, stays a region: nearby bytes are saved as anchors and the span is searched for after edits. That identity is heuristic."), extra=0.5)
        self.clear_all()

        self.say(T("Y la heurística tiene trampas. Este es el error más sutil que apareció en la auditoría.",
                   "And heuristics have traps. This was the subtlest bug found during the audit."))
        block = ["if (x > 0) {", "  y = y + 1;", "}"]
        a = card(code_block(block, size=20), T("bloque A · leído", "block A · read"), color=BLUE_D, pad=0.2)
        b = card(code_block(block, size=20), T("bloque B · idéntico", "block B · identical"), pad=0.2)
        pair = VGroup(a, b).arrange(DOWN, buff=0.5).move_to(LEFT * 3.2 + UP * 0.8)
        self.play(FadeIn(pair))
        self.say(T("Un archivo tiene dos bloques idénticos, y el agente leyó el primero. Luego el primero cambia; el segundo no.",
                   "A file has two identical blocks, and the agent read the first. Then the first changes; the second does not."))
        a_line = a[1][1]
        changed = CodeLine("  y = y + 2;", size=20, t2c={"2": NEW})
        changed.move_to(a_line, aligned_edge=LEFT)
        self.play(Transform(a_line, changed))
        search = label(T("buscar los bytes viejos en todo el archivo…", "search the whole file for the old bytes…"), size=20, color=MUTED).move_to(RIGHT * 3.2 + UP * 2.0)
        self.play(FadeIn(search))
        match = SurroundingRectangle(b, color=NEW, buff=0.06)
        found = label(T("coincidencia perfecta ✓", "perfect match ✓"), size=22, color=NEW).next_to(search, DOWN, buff=0.4)
        self.play(Create(match), FadeIn(found))
        self.say(T("Una búsqueda global de los bytes antiguos encuentra una coincidencia perfecta… en el bloque equivocado.",
                   "A global search for the old bytes finds a perfect match… in the wrong block."))
        wrong = label(T("creíble, pero falso ✗", "credible, but wrong ✗"), size=22, color=OLD).move_to(found)
        self.play(match.animate.set_color(OLD), Transform(found, wrong))
        self.say(T("Eso es peor que no devolver nada, porque el texto proyectado parece correcto.",
                   "That is worse than a missing result, because the projected text looks credible."))
        fix = VGroup(
            label(T("· contar ocurrencias", "· count occurrences"), size=20),
            label(T("· comparar anclas vecinas", "· compare surrounding anchors"), size=20),
            label(T("· si es ambiguo → omitir", "· if ambiguous → omit"), size=20, color=HI),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.25).next_to(found, DOWN, buff=0.5)
        self.play(LaggedStart(*[FadeIn(f, shift=0.1 * RIGHT) for f in fix], lag_ratio=0.4))
        self.say(T("La versión corregida usa la ocurrencia y las anclas, y omite lo que no puede desambiguar. Omitir y volver a leer siguen siendo resultados necesarios.",
                   "The revised resolver uses occurrence and anchors, and omits what it cannot disambiguate. Omission and a fresh read remain necessary outcomes."), extra=0.5)
        self.clear_all()


class S5Budget(Base):
    def construct(self):
        self.chapter("4", T("Elegir lo que cabe", "Selecting what fits"))
        self.say(T("Las unidades resueltas compiten por un presupuesto de bytes para la proyección.",
                   "Resolved units compete for a projection byte budget."))
        scale = 0.011
        budget_bytes = 900
        bar = Rectangle(width=budget_bytes * scale, height=0.6, color=GREY_B).move_to(DOWN * 1.35)
        bar_lbl = label(T("presupuesto: 900 bytes", "budget: 900 bytes"), size=20, color=MUTED).next_to(bar, DOWN, buff=0.2)
        units = [
            ("price.js · total", 76, 5, FRESH, None),
            ("cart.py · apply", 310, 4, BLUE_C, None),
            ("cart.py · file", 540, 3, PURPLE_B, "overlap"),
            ("util.go · Parse", 620, 2, GOLD_B, "budget"),
            ("rate.rs · region", 120, 1, TEAL_E, None),
        ]
        blocks = VGroup()
        for name, size, recency, color, _ in units:
            r = Rectangle(width=size * scale, height=0.5, color=color, fill_color=color, fill_opacity=0.35)
            t = label(f"{name}  ({size} B)", size=18, font=MONO).next_to(r, UP, buff=0.06, aligned_edge=LEFT)
            blocks.add(VGroup(r, t))
        blocks.arrange(DOWN, aligned_edge=LEFT, buff=0.18)
        blocks.move_to([bar.get_left()[0] + blocks.width / 2, 3.55 - blocks.height / 2, 0])
        rec = VGroup(*[label(f"t={u[2]}", size=18, color=MUTED).next_to(blocks[i], LEFT, buff=0.3) for i, u in enumerate(units)])
        self.play(Create(bar), FadeIn(bar_lbl), LaggedStart(*[FadeIn(b) for b in blocks], lag_ratio=0.15), FadeIn(rec))
        self.say(T("La política actual es simple: ordenar por la observación más reciente, saltar las que se solapan y admitir las que caben.",
                   "The current policy is simple: sort by most recent observation, skip overlapping candidates, and admit units that fit."), extra=0.3)
        x = bar.get_left()[0]
        for (name, size, _, color, reason), blk in zip(units, blocks):
            if reason is None:
                target = blk[0].copy().stretch_to_fit_height(0.6)
                target.move_to([x + target.width / 2, bar.get_y(), 0])
                self.play(TransformFromCopy(blk[0], target), run_time=0.7)
                x += target.width
            else:
                why = T("se solapa con cart.py · apply", "overlaps cart.py · apply") if reason == "overlap" else T("no cabe · no se trunca", "does not fit · never truncated")
                note = label(why, size=19, color=OLD).next_to(blk, RIGHT, buff=0.3)
                self.play(blk.animate.set_opacity(0.3), FadeIn(note), run_time=0.7)
        self.say(T("No se corta una función para rellenar los últimos bytes. El resultado se ordena por ruta, de forma determinista.",
                   "A function is never truncated to fill the last few bytes. The selection is rendered in deterministic path order."), extra=0.3)
        self.say(T("No hay puntuación de relevancia aprendida, ni grafo de dependencias, ni embeddings. Es inspeccionable… pero una función puede llegar sin un import o un llamador que importaban.",
                   "There is no learned relevance score, dependency graph, or embedding search. It is inspectable… but a function can arrive without an important import or caller."), extra=0.5)
        self.say(T("Y el presupuesto cuenta cabeceras y cuerpos de la proyección. No es un límite de tokens ni una estimación de coste.",
                   "And the budget counts projection headers and bodies. It is not a token limit or a cost estimate."), extra=0.3)
        self.clear_all()


class S6FailClosed(Base):
    def construct(self):
        self.chapter("5", T("La petición falla como una unidad", "The request must fail as a unit"))
        checks = [
            T("hash de cada reemplazo = hash del resultado nativo", "each replacement hash = native result hash"),
            T("hash de la proyección y presupuesto", "projection hash and budget"),
            T("llamadas y resultados siguen emparejados", "tool calls and results stay paired"),
            T("ninguna lectura con éxito sin observación", "no successful read without an observation"),
        ]
        items = VGroup(*[label("☐  " + c, size=28) for c in checks]).arrange(DOWN, aligned_edge=LEFT, buff=0.45).move_to(UP * 1.0)
        self.say(T("Antes de enviar nada, el bridge verifica el plan entero.", "Before anything is sent, the bridge verifies the whole plan."))
        self.play(LaggedStart(*[FadeIn(i, shift=0.1 * RIGHT) for i in items], lag_ratio=0.25))
        for it in items:
            tick = label("✓", size=30, color=NEW).move_to(it[0])
            self.play(FadeTransform(it[0], tick), run_time=0.35)
        self.say(T("El último punto importa: si el motor perdiera su estado, una lectura antigua volvería a colarse como texto normal. El bridge de Pi bloquea ese caso, también al reanudar una sesión guardada.",
                   "The last one matters: if the engine lost its state, an old read could silently slip back in as ordinary text. The Pi bridge blocks that case, including on saved-session resume."), extra=0.5)
        self.clear_all()

        env = card(label(T("petición reescrita", "rewritten request"), size=28, weight=BOLD), color=FRESH, pad=0.4).move_to(LEFT * 3.8 + UP * 0.9)
        disk = card(code_block(price_lines(20), size=24, t2c={"20": NEW}), "disk", pad=0.3).move_to(RIGHT * 3.3 + UP * 0.9)
        commit = label(T("commit: releer y comparar revisiones", "commit: reread and compare revisions"), size=28, color=HI).move_to(UP * 3.1)
        self.play(FadeIn(env), FadeIn(disk), FadeIn(commit))
        arr = DoubleArrow(env.get_right(), disk.get_left(), buff=0.2, color=HI)
        self.play(GrowArrow(arr))
        self.say(T("Al confirmar, el motor vuelve a leer los archivos elegidos y compara sus revisiones con las usadas al preparar.",
                   "On commit, the engine rereads the selected files and compares their revisions with those used during prepare."))
        ok = label(T("iguales → se envía", "same → dispatch"), size=26, color=NEW).next_to(env, DOWN, buff=0.4)
        self.play(FadeIn(ok))
        self.wait(0.8)
        num = disk[1][1].part("20")
        num2 = Text("25", font=MONO, font_size=24, color=OLD).move_to(num)
        self.play(Transform(num, num2), Flash(num2, color=OLD))
        bad = label(T("cambió → se descarta", "changed → discard"), size=26, color=OLD).move_to(ok)
        cross = Cross(env[0], stroke_color=OLD, stroke_width=5).set_z_index(2)
        self.play(Transform(ok, bad), Create(cross))
        self.say(T("Si alguno cambió entre medias, el host debe tirar esa petición.", "If one changed in between, the host must discard that request."))
        self.say(T("Es una comprobación optimista: no es una instantánea atómica ni un bloqueo del workspace. Si necesitas más garantías, las tiene que dar el host.",
                   "It is an optimistic check: not an atomic snapshot, not a workspace lock. Stronger consistency has to come from the host."), extra=0.4)
        self.say(T("Y depende del host: Pi captura los errores de sus extensiones, así que lanzar una excepción no bastaba. El bridge tiene que abortar el turno, y los tests comprueban que la petición nunca llega al proveedor.",
                   "It also depends on the host: Pi catches extension errors, so throwing was not enough. The bridge must abort the turn, and tests check the request never reaches the provider."), extra=0.6)
        self.clear_all()

        left = card(VGroup(label(T("plan inválido", "invalid plan"), size=24, weight=BOLD, color=OLD),
                           label(T("no se envía nada", "nothing is dispatched"), size=20)).arrange(DOWN, buff=0.25), color=OLD, pad=0.35)
        right = card(VGroup(label(T("plan válido, unidad perdida", "valid plan, unit lost"), size=24, weight=BOLD, color=GOLD_B),
                            label(T("borrada · ambigua · demasiado grande", "deleted · ambiguous · too large"), size=18, color=MUTED),
                            label("[unit-id unavailable]", size=18, font=MONO, color=GOLD_B)).arrange(DOWN, buff=0.25), color=GOLD_B, pad=0.35)
        VGroup(left, right).arrange(RIGHT, buff=1.0).move_to(UP * 0.8)
        self.play(FadeIn(left), FadeIn(right))
        self.say(T("No hay que confundir dos casos: un plan inválido detiene el envío; un plan válido puede omitir código y dejar un marcador de «no disponible».",
                   "Two cases must not be confused: an invalid plan stops dispatch; a valid plan may omit code and leave an unavailable marker."), extra=0.5)
        self.clear_all()


class S7Evidence(Base):
    def construct(self):
        self.chapter("6", T("Lo que se midió", "What was measured"))
        self.say(T("Primer prototipo: cinco trazas fijas de Express, Flask, Go tools y ripgrep. Contexto estrecho frente al archivo completo.",
                   "First prototype: five fixed traces from Express, Flask, Go tools, and ripgrep. Narrow context versus the whole file."), extra=0.3)
        data = [
            ("Express createApplication", 1075, 1778),
            ("Flask View.as_view", 2715, 7111),
            ("Flask view (nested)", 829, 7120),
            ("Go ContainingPackage", 1425, 6034),
            ("ripgrep is_fixed_strings", 2460, 14658),
        ]
        scale = 7.2 / 14658
        rows = VGroup()
        for name, narrow, whole in data:
            nm = label(name, size=20, font=MONO)
            wb = Rectangle(width=whole * scale, height=0.26, stroke_width=0, fill_color=GREY_C, fill_opacity=0.8)
            nb = Rectangle(width=narrow * scale, height=0.26, stroke_width=0, fill_color=FRESH, fill_opacity=0.95)
            bars = VGroup(wb, nb).arrange(DOWN, buff=0.05, aligned_edge=LEFT)
            wl = label(f"{whole:,}", size=17, color=GREY_B).next_to(wb, RIGHT, buff=0.1)
            nl = label(f"{narrow:,}", size=17, color=FRESH).next_to(nb, RIGHT, buff=0.1)
            rows.add(VGroup(nm, bars, wl, nl))
        for i, r in enumerate(rows):
            r[0].move_to([-6.7 + r[0].width / 2, 2.55 - i * 0.8, 0])
            r[1].move_to([-2.3 + r[1].width / 2, 2.55 - i * 0.8, 0])
            r[2].next_to(r[1][0], RIGHT, buff=0.1)
            r[3].next_to(r[1][1], RIGHT, buff=0.1)
        legend = VGroup(
            VGroup(Square(0.18, fill_color=FRESH, fill_opacity=1, stroke_width=0), label(T("estrecho (unidad)", "narrow (unit)"), size=19)).arrange(RIGHT, buff=0.12),
            VGroup(Square(0.18, fill_color=GREY_C, fill_opacity=1, stroke_width=0), label(T("archivo completo", "whole file"), size=19)).arrange(RIGHT, buff=0.12),
        ).arrange(RIGHT, buff=0.5).move_to(UP * 3.45 + RIGHT * 1.5)
        self.play(FadeIn(legend))
        for r in rows:
            self.play(FadeIn(r[0]), GrowFromEdge(r[1][0], LEFT), GrowFromEdge(r[1][1], LEFT), FadeIn(r[2]), FadeIn(r[3]), run_time=0.6)
        total = label(T("total: 8,504 vs 36,701 bytes  →  76.8 % menos", "total: 8,504 vs 36,701 bytes  →  76.8% fewer"), size=30, weight=BOLD, color=HI).move_to(DOWN * 1.6)
        self.play(Write(total))
        self.say(T("En total, 76,8 % menos bytes, y las cinco comprobaciones de código requerido pasaron.",
                   "In total, 76.8% fewer bytes, and all five required-code checks passed."))
        self.say(T("Pero ojo con lo que significa: son bytes del texto final de los mensajes, no tokens facturados. Ningún modelo resolvió ninguna tarea en este experimento.",
                   "But be careful what it means: these are bytes of final message text, not billed tokens. No model solved a task in this experiment."), extra=0.5)
        self.say(T("Dice que el código exigido sobrevivió. No dice que sobreviviera todo lo que una tarea real necesita, ni nada sobre coste en dólares.",
                   "It says the required code survived. It does not say every dependency a real task needs survived, nor anything about dollar savings."), extra=0.4)
        self.clear_all()

        self.say(T("Después vino un piloto pequeño con un agente real: Pi 0.85.0 y deepseek-v4-flash, cinco tareas, una ejecución base y una con FreshCtx por tarea.",
                   "Then came a small pilot with a live agent: Pi 0.85.0 and deepseek-v4-flash, five tasks, one baseline and one FreshCtx run per task."), extra=0.5)
        head = [T("tarea", "task"), "baseline", "FreshCtx", T("peticiones", "requests")]
        tasks = [
            (T("constante rate", "rate constant"), True, True, "2 / 5"),
            (T("símbolo movido", "moved symbol"), True, False, "2 / 8"),
            (T("cambio de operador", "operator shift"), True, True, "2 / 4"),
            (T("base de impuestos", "tax base"), True, False, "2 / 8"),
            (T("recargo de presupuesto", "quote surcharge"), True, True, "2 / 2"),
        ]
        xs = [-3.6, 0.2, 2.6, 5.0]
        header = VGroup(*[label(h, size=24, weight=BOLD, color=MUTED).move_to([x, 3.2, 0]) for h, x in zip(head, xs)])
        self.play(FadeIn(header))
        rows = VGroup()
        for i, (name, b, f, req) in enumerate(tasks):
            y = 2.45 - i * 0.65
            rows.add(VGroup(
                label(name, size=24).move_to([xs[0], y, 0]),
                label(T("pasa", "pass") if b else T("falla", "fail"), size=24, color=NEW if b else OLD).move_to([xs[1], y, 0]),
                label(T("pasa", "pass") if f else T("falla", "fail"), size=24, color=NEW if f else OLD).move_to([xs[2], y, 0]),
                label(req, size=24, font=MONO).move_to([xs[3], y, 0]),
            ))
        self.play(LaggedStart(*[FadeIn(r) for r in rows], lag_ratio=0.2), run_time=1.6)
        score = label(T("baseline 5/5  ·  FreshCtx 3/5", "baseline 5/5  ·  FreshCtx 3/5"), size=32, weight=BOLD, color=HI).move_to(DOWN * 1.0)
        self.play(Write(score))
        self.say(T("La primera petición reanudada del baseline tenía código viejo en los cinco casos. La de FreshCtx tenía el código actual en los cinco.",
                   "The baseline's first resumed request held old code in all five cases. FreshCtx's held current code in all five."), extra=0.3)
        self.say(T("Y aun así: baseline completó 5 de 5, FreshCtx 3 de 5. Los dos fallos agotaron su límite de ocho peticiones. El baseline podía releer el archivo, así que el contexto viejo no le obligó a equivocarse.",
                   "And yet: baseline completed 5 of 5, FreshCtx 3 of 5. The two failures hit their eight-request cap. The baseline could reread the file, so stale context did not force a wrong answer."), extra=0.6)
        self.say(T("Son cinco observaciones pareadas, con el baseline siempre primero. Y el tratamiento también cambió la descripción del lector y el formato del código, así que no aísla el efecto de la frescura.",
                   "These are five paired observations, baseline first. The treatment also changed the reader description and code format, so it does not isolate the effect of freshness."), extra=0.6)
        self.clear_all()

        a = card(label(T("entregar bytes actuales", "delivering current bytes"), size=26, weight=BOLD, color=FRESH), color=FRESH, pad=0.35)
        b = card(label(T("completar la tarea", "completing the task"), size=26, weight=BOLD, color=HI), color=HI, pad=0.35)
        VGroup(a, b).arrange(RIGHT, buff=1.6).move_to(UP * 1.0)
        neq = label("≠", size=60).move_to((a.get_right() + b.get_left()) / 2)
        self.play(FadeIn(a), FadeIn(b), Write(neq))
        la = label(T("se comprueba en la frontera\nde la petición", "checkable at the\nrequest boundary"), size=22, color=MUTED).next_to(a, DOWN, buff=0.35)
        lb = label(T("depende de lo que el modelo haga:\nformato, contexto que falta, contrato, parar", "depends on what the model does:\nformat, missing context, contract, stopping"), size=22, color=MUTED).next_to(b, DOWN, buff=0.35)
        self.play(FadeIn(la), FadeIn(lb))
        self.say(T("Esa es la lección central. La primera propiedad se puede verificar. La segunda depende de lo que el modelo haga con esa petición.",
                   "That is the central lesson. The first property can be verified. The second depends on what the model does with that request."), extra=0.4)
        self.say(T("Una prueba posterior sí confirmó la frescura en la petición real: con FreshCtx, el proveedor recibió TARGET_RATE = 12 sin releer; sin FreshCtx, seguía en 10. Frescura, no mejor rendimiento.",
                   "A later check did confirm request freshness on the real path: with FreshCtx the provider received TARGET_RATE = 12 without a reread; without it, 10. Freshness, not better performance."), extra=0.6)
        self.clear_all()


class S8Close(Base):
    def construct(self):
        self.chapter("7", T("Diferencias y límites", "Differences and limits"))
        cols = [
            (T("volver a leer", "read again"), T("el modelo decide\nversiones acumuladas", "model decides\nversions pile up"), BLUE_B),
            (T("compactar", "compact"), T("menos texto\nhechos obsoletos", "less text\nobsolete facts"), GOLD_B),
            ("CORVUS", T("registra archivos\ny los refresca", "registers files\nand refreshes them"), PURPLE_B),
            ("FreshCtx", T("función o región\ncuando puede", "function or region\nwhen it can"), FRESH),
        ]
        cards = VGroup()
        for n, d, c in cols:
            inner = VGroup(label(n, size=28, weight=BOLD, color=c), label(d, size=21, color=GREY_A)).arrange(DOWN, buff=0.35)
            box = RoundedRectangle(corner_radius=0.12, width=3.2, height=2.2, color=c, stroke_width=2).set_fill(PANEL, 1).set_z_index(-1)
            cards.add(VGroup(box, inner.move_to(box)))
        cards.arrange(RIGHT, buff=0.3).move_to(UP * 1.2)
        self.play(LaggedStart(*[FadeIn(c, shift=0.1 * UP) for c in cards], lag_ratio=0.25), run_time=1.6)
        self.say(T("FreshCtx sigue una dirección explorada por CORVUS, que registra archivos y refresca su contenido. FreshCtx prueba una unidad más estrecha: una función o región cuando puede identificarla.",
                   "FreshCtx follows a direction explored by CORVUS, which registers files and refreshes their contents. FreshCtx explores a narrower unit: a function or region when it can identify one."), extra=0.6)
        self.say(T("La comparación local con archivos completos está inspirada en CORVUS; no reproduce su evaluación.",
                   "Its local whole-file comparison is inspired by CORVUS; it does not reproduce that paper's evaluation."))
        self.clear_all()

        limits = VGroup(
            label(T("· no refresca explicaciones del asistente ni resúmenes", "· does not refresh assistant explanations or summaries"), size=28),
            label(T("· identidad de regiones heurística; puede omitir", "· region identity is heuristic; it may omit"), size=28),
            label(T("· selección por recencia, no por relevancia", "· selection by recency, not relevance"), size=28),
            label(T("· commit optimista, sin bloqueo del workspace", "· optimistic commit, no workspace lock"), size=28),
            label(T("· Pi verificado; OpenHands solo con fixtures", "· Pi verified; OpenHands fixtures only"), size=28),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.32).move_to(UP * 1.1)
        self.play(LaggedStart(*[FadeIn(l, shift=0.1 * RIGHT) for l in limits], lag_ratio=0.2), run_time=1.8)
        self.say(T("Refrescar una función no retira una conclusión anterior sobre ella. Ese es otro problema, y una buena razón para mantener las afirmaciones estrechas.",
                   "Refreshing a function does not retract an earlier conclusion about it. That is a separate problem, and a good reason to keep claims narrow."), extra=0.5)
        self.clear_all()

        nexts = VGroup(
            label(T("1 · variar solo la frescura, con el mismo formato e instrucciones", "1 · vary only freshness, same format and instructions"), size=25),
            label(T("2 · regiones vs símbolos vs archivos donde importan las dependencias", "2 · regions vs symbols vs files where dependencies matter"), size=25),
            label(T("3 · medir peticiones completas, tokens, caché, latencia y resultados juntos", "3 · measure full requests, tokens, cache, latency, outcomes together"), size=25),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.35).move_to(UP * 1.2)
        head = label(T("Próximos experimentos", "Next experiments"), size=28, weight=BOLD).next_to(nexts, UP, buff=0.5)
        self.play(FadeIn(head), LaggedStart(*[FadeIn(n, shift=0.1 * RIGHT) for n in nexts], lag_ratio=0.3), run_time=1.6)
        self.say(T("Tres experimentos harían la evidencia más útil.", "Three follow-up experiments would make the evidence more useful."), extra=1.5)
        self.clear_all()

        line = Line(UP * 2.6, DOWN * 1.6, color=HI, stroke_width=4)
        left = VGroup(label(T("historial registrado", "recorded history"), size=26, weight=BOLD),
                      label("quantity * 10", size=22, font=MONO, color=OLD)).arrange(DOWN, buff=0.35).move_to(LEFT * 3.4 + UP * 0.6)
        right = VGroup(label(T("vista actual enviada al modelo", "current view sent to the model"), size=26, weight=BOLD, color=FRESH),
                       label("quantity * 20", size=22, font=MONO, color=NEW)).arrange(DOWN, buff=0.35).move_to(RIGHT * 3.4 + UP * 0.6)
        self.play(Create(line))
        self.play(FadeIn(left, shift=0.2 * RIGHT), FadeIn(right, shift=0.2 * LEFT))
        self.say(T("Empezó con un resultado viejo y un archivo cambiado. Lo útil es una frontera explícita: la historia registrada a un lado, la vista actual del código que recibe el modelo al otro.",
                   "It started with an old tool result and a changed file. The useful artifact is an explicit boundary: recorded history on one side, the current source view sent to a model on the other."), extra=0.6)
        self.say(T("Una frontera que se puede inspeccionar, cambiar y medir.", "A boundary you can inspect, change, and measure."), extra=0.8)
        self.clear_all()
        brand = label("FreshCtx", size=54, weight=BOLD, color=FRESH)
        site = label("felipebasurto.com/blog/model-context-is-not-static", size=22, color=MUTED).next_to(brand, DOWN, buff=0.4)
        self.play(Write(brand), FadeIn(site))
        self.wait(3)
        self.play(FadeOut(brand), FadeOut(site))


SCENES = ["S1Hook", "S2Cache", "S3Pipeline", "S4Identity", "S5Budget", "S6FailClosed", "S7Evidence", "S8Close"]
