# FreshCtx explainer: narration script

Generated from freshctx_explainer.py by `python narration.py`. Each line is one on-screen caption, in order.

## Español

### S1Hook

- Un agente de programación lee una función de un archivo.
- Esa lectura queda guardada en la conversación como resultado de una herramienta.
- Después, alguien cambia el multiplicador a 20.
- El agente sigue trabajando. ¿Qué código verá el modelo en su próxima llamada?
- El archivo en disco dice 20. El resultado antiguo todavía dice 10.
- Las herramientas operan sobre el archivo actual, pero el modelo razona sobre el viejo.
- El agente puede volver a leer el archivo, y a menudo lo hace. Pero entonces la frescura depende de que el modelo decida repetir la lectura.
- ¿Y si fuera el software que mantiene la conversación quien se encargara de refrescar el código? Esa pregunta es FreshCtx.

### S2Cache

**Una conversación también es una caché**
- Un agente combina un modelo de lenguaje con un harness: el programa que ejecuta herramientas, guarda sus resultados y construye la siguiente petición.
- El modelo solo ve los mensajes de esa petición. No ve automáticamente un cambio posterior en un archivo que se leyó antes.
- Un resultado de lectura tiene dos trabajos a la vez.
- Ambos coinciden… hasta que el archivo cambia.
- Como historia sigue siendo correcto. Como código actual, ya no lo es.
- Hay varias salidas habituales. Cada una tiene su problema.
- Volver a leer añade otra versión. Cada una fue correcta en su momento, y todas acaban en el contexto.
- Compactar la historia en un resumen puede conservar un hecho obsoleto después de que desaparezca la fuente que lo justificaba.
- FreshCtx separa los dos trabajos: la historia guardada no se toca, y solo se reescribe la copia que sale hacia el modelo.

### S3Pipeline

**De una lectura a la siguiente petición**
- FreshCtx es un proceso de Node persistente que corre al lado del agente. Un bridge lo conecta con el lector de archivos y con el último gancho antes de enviar la petición.
- Hablan con JSON delimitado por líneas. El motor nunca llama al proveedor del modelo.
- Cuatro pasos. Veámoslos con el ejemplo de total().
- Observar: cuando una lectura tiene éxito, el bridge le dice a FreshCtx de dónde salieron exactamente esos bytes.
- El rango se mide en bytes UTF-8, sin incluir el final. Un emoji ocupa varios bytes, y los números de línea añadidos para mostrar no son bytes del código.
- FreshCtx guarda tres identidades distintas, y no hay que confundirlas.
- Preparar y aplicar: tras el cambio, el bridge copia la petición que está a punto de enviar.
- En la copia, el resultado antiguo se sustituye por un marcador corto con el ID de la unidad. La llamada y su resultado siguen emparejados.
- Y la vista actual del código se añade al final como un mensaje nuevo: la proyección.
- Fíjate: el historial guardado sigue diciendo 10. Nada se borra; solo cambia lo que viaja al modelo.
- Un detalle importante: solo cuentan las observaciones que siguen presentes en la petición. Si una compactación olvidó una lectura, no resucita en silencio.
- Este ejemplo es ejecutable: npm run demo arranca el motor real, edita el archivo, comprueba los hashes y confirma la reescritura. Sin llamar a ningún LLM.

### S4Identity

**¿Qué cuenta como «el mismo código»?**
- Refrescar un archivo entero es fácil: guardas su ruta y lo vuelves a leer. Refrescar un trozo exige decidir qué es ese trozo después de que las ediciones lo muevan.
- FreshCtx usa tres tipos de unidad, cada una con su forma de reencontrarse.
- En Python, JavaScript, TypeScript, Go y Rust, Tree-sitter convierte un rango dentro de una función en un símbolo.
- Si alguien inserta líneas encima, los offsets cambian… pero el selector no.
- FreshCtx vuelve a encontrar la declaración y proyecta su cuerpo actual.
- Ojo: esto puede ensanchar la lectura. Una sola línea vista dentro de una función puede traer la función entera.
- Si el lenguaje no está soportado, el parseo falla o el símbolo se pierde, puede caer al archivo completo actual.
- Algo como const TAX, fuera de cualquier función, queda como región: se guardan bytes vecinos como anclas y se busca el tramo tras las ediciones. Es una identidad heurística.
- Y la heurística tiene trampas. Este es el error más sutil que apareció en la auditoría.
- Un archivo tiene dos bloques idénticos, y el agente leyó el primero. Luego el primero cambia; el segundo no.
- Una búsqueda global de los bytes antiguos encuentra una coincidencia perfecta… en el bloque equivocado.
- Eso es peor que no devolver nada, porque el texto proyectado parece correcto.
- La versión corregida usa la ocurrencia y las anclas, y omite lo que no puede desambiguar. Omitir y volver a leer siguen siendo resultados necesarios.

### S5Budget

**Elegir lo que cabe**
- Las unidades resueltas compiten por un presupuesto de bytes para la proyección.
- La política actual es simple: ordenar por la observación más reciente, saltar las que se solapan y admitir las que caben.
- No se corta una función para rellenar los últimos bytes. El resultado se ordena por ruta, de forma determinista.
- No hay puntuación de relevancia aprendida, ni grafo de dependencias, ni embeddings. Es inspeccionable… pero una función puede llegar sin un import o un llamador que importaban.
- Y el presupuesto cuenta cabeceras y cuerpos de la proyección. No es un límite de tokens ni una estimación de coste.

### S6FailClosed

**La petición falla como una unidad**
- Antes de enviar nada, el bridge verifica el plan entero.
- El último punto importa: si el motor perdiera su estado, una lectura antigua volvería a colarse como texto normal. El bridge de Pi bloquea ese caso, también al reanudar una sesión guardada.
- Al confirmar, el motor vuelve a leer los archivos elegidos y compara sus revisiones con las usadas al preparar.
- Si alguno cambió entre medias, el host debe tirar esa petición.
- Es una comprobación optimista: no es una instantánea atómica ni un bloqueo del workspace. Si necesitas más garantías, las tiene que dar el host.
- Y depende del host: Pi captura los errores de sus extensiones, así que lanzar una excepción no bastaba. El bridge tiene que abortar el turno, y los tests comprueban que la petición nunca llega al proveedor.
- No hay que confundir dos casos: un plan inválido detiene el envío; un plan válido puede omitir código y dejar un marcador de «no disponible».

### S7Evidence

**Lo que se midió**
- Primer prototipo: cinco trazas fijas de Express, Flask, Go tools y ripgrep. Contexto estrecho frente al archivo completo.
- En total, 76,8 % menos bytes, y las cinco comprobaciones de código requerido pasaron.
- Pero ojo con lo que significa: son bytes del texto final de los mensajes, no tokens facturados. Ningún modelo resolvió ninguna tarea en este experimento.
- Dice que el código exigido sobrevivió. No dice que sobreviviera todo lo que una tarea real necesita, ni nada sobre coste en dólares.
- Después vino un piloto pequeño con un agente real: Pi 0.85.0 y deepseek-v4-flash, cinco tareas, una ejecución base y una con FreshCtx por tarea.
- La primera petición reanudada del baseline tenía código viejo en los cinco casos. La de FreshCtx tenía el código actual en los cinco.
- Y aun así: baseline completó 5 de 5, FreshCtx 3 de 5. Los dos fallos agotaron su límite de ocho peticiones. El baseline podía releer el archivo, así que el contexto viejo no le obligó a equivocarse.
- Son cinco observaciones pareadas, con el baseline siempre primero. Y el tratamiento también cambió la descripción del lector y el formato del código, así que no aísla el efecto de la frescura.
- Esa es la lección central. La primera propiedad se puede verificar. La segunda depende de lo que el modelo haga con esa petición.
- Una prueba posterior sí confirmó la frescura en la petición real: con FreshCtx, el proveedor recibió TARGET_RATE = 12 sin releer; sin FreshCtx, seguía en 10. Frescura, no mejor rendimiento.

### S8Close

**Diferencias y límites**
- FreshCtx sigue una dirección explorada por CORVUS, que registra archivos y refresca su contenido. FreshCtx prueba una unidad más estrecha: una función o región cuando puede identificarla.
- La comparación local con archivos completos está inspirada en CORVUS; no reproduce su evaluación.
- Refrescar una función no retira una conclusión anterior sobre ella. Ese es otro problema, y una buena razón para mantener las afirmaciones estrechas.
- Tres experimentos harían la evidencia más útil.
- Empezó con un resultado viejo y un archivo cambiado. Lo útil es una frontera explícita: la historia registrada a un lado, la vista actual del código que recibe el modelo al otro.
- Una frontera que se puede inspeccionar, cambiar y medir.

## English

### S1Hook

- A coding agent reads a function from a file.
- That read is stored in the conversation as a tool result.
- Then someone changes the multiplier to 20.
- The agent keeps working. What code does the model see on its next call?
- The file on disk says 20. The old tool result still says 10.
- The tools operate on the current file, but the model reasons from the old one.
- The agent can read the file again, and often does. But then freshness depends on the model deciding to repeat a tool call.
- What if the software that maintains the conversation took responsibility for refreshing code instead? That question became FreshCtx.

### S2Cache

**A conversation is also a cache**
- An agent combines a language model with a harness: the program that runs tools, records their results, and builds the next model request.
- The model sees only the messages in that request. It does not automatically see a later edit to a file read earlier.
- A file-read result has two jobs at once.
- Both agree… until the file changes.
- As history it is still correct. As current source, it no longer is.
- There are a few common ways out. Each has a problem.
- Reading again adds another version. Each was correct at a different moment, and all of them end up in context.
- Compressing history into a summary can preserve an obsolete fact after the source that justified it has disappeared.
- FreshCtx separates the two jobs: saved history is untouched, and only the copy sent to the model is rewritten.

### S3Pipeline

**From one read to the next request**
- FreshCtx is a persistent Node process running beside the agent. A bridge connects it to the host's reader and to its final request hook.
- They exchange newline-delimited JSON. The engine never calls a model provider.
- Four steps. Let's walk through them with total().
- Observe: when a read succeeds, the bridge tells FreshCtx exactly where those bytes came from.
- The range is zero-based, end-exclusive UTF-8 bytes. An emoji takes several bytes, and display line numbers are not source bytes.
- FreshCtx keeps three different identities, and they must not be confused.
- Prepare and apply: after the edit, the bridge copies the request it is about to send.
- In the copy, the old result becomes a short unit marker. The tool call and its result stay paired.
- And the current view of the code is appended as a new message: the projection.
- Notice: saved history still says 10. Nothing is erased; only what travels to the model changes.
- One detail: only observations still present in the outgoing request count. If compaction forgot a read, it does not silently come back.
- This example is executable: npm run demo starts the real engine, edits the file, checks hashes, and commits the rewrite. No LLM is called.

### S4Identity

**What counts as the same code?**
- Refreshing a whole file is easy: keep its path and read it again. Refreshing a small part means deciding what that part is after edits move it.
- FreshCtx uses three kinds of unit, each found again in its own way.
- For Python, JavaScript, TypeScript, Go, and Rust, Tree-sitter turns a range inside a function into a symbol.
- If someone inserts lines above, the offsets change… but the selector does not.
- FreshCtx locates the declaration again and projects its current body.
- Careful: this can widen the read. One observed line inside a function may bring in the whole function.
- Unsupported languages, broken parses, or lost symbols may fall back to the current whole file.
- Something like const TAX, outside any function, stays a region: nearby bytes are saved as anchors and the span is searched for after edits. That identity is heuristic.
- And heuristics have traps. This was the subtlest bug found during the audit.
- A file has two identical blocks, and the agent read the first. Then the first changes; the second does not.
- A global search for the old bytes finds a perfect match… in the wrong block.
- That is worse than a missing result, because the projected text looks credible.
- The revised resolver uses occurrence and anchors, and omits what it cannot disambiguate. Omission and a fresh read remain necessary outcomes.

### S5Budget

**Selecting what fits**
- Resolved units compete for a projection byte budget.
- The current policy is simple: sort by most recent observation, skip overlapping candidates, and admit units that fit.
- A function is never truncated to fill the last few bytes. The selection is rendered in deterministic path order.
- There is no learned relevance score, dependency graph, or embedding search. It is inspectable… but a function can arrive without an important import or caller.
- And the budget counts projection headers and bodies. It is not a token limit or a cost estimate.

### S6FailClosed

**The request must fail as a unit**
- Before anything is sent, the bridge verifies the whole plan.
- The last one matters: if the engine lost its state, an old read could silently slip back in as ordinary text. The Pi bridge blocks that case, including on saved-session resume.
- On commit, the engine rereads the selected files and compares their revisions with those used during prepare.
- If one changed in between, the host must discard that request.
- It is an optimistic check: not an atomic snapshot, not a workspace lock. Stronger consistency has to come from the host.
- It also depends on the host: Pi catches extension errors, so throwing was not enough. The bridge must abort the turn, and tests check the request never reaches the provider.
- Two cases must not be confused: an invalid plan stops dispatch; a valid plan may omit code and leave an unavailable marker.

### S7Evidence

**What was measured**
- First prototype: five fixed traces from Express, Flask, Go tools, and ripgrep. Narrow context versus the whole file.
- In total, 76.8% fewer bytes, and all five required-code checks passed.
- But be careful what it means: these are bytes of final message text, not billed tokens. No model solved a task in this experiment.
- It says the required code survived. It does not say every dependency a real task needs survived, nor anything about dollar savings.
- Then came a small pilot with a live agent: Pi 0.85.0 and deepseek-v4-flash, five tasks, one baseline and one FreshCtx run per task.
- The baseline's first resumed request held old code in all five cases. FreshCtx's held current code in all five.
- And yet: baseline completed 5 of 5, FreshCtx 3 of 5. The two failures hit their eight-request cap. The baseline could reread the file, so stale context did not force a wrong answer.
- These are five paired observations, baseline first. The treatment also changed the reader description and code format, so it does not isolate the effect of freshness.
- That is the central lesson. The first property can be verified. The second depends on what the model does with that request.
- A later check did confirm request freshness on the real path: with FreshCtx the provider received TARGET_RATE = 12 without a reread; without it, 10. Freshness, not better performance.

### S8Close

**Differences and limits**
- FreshCtx follows a direction explored by CORVUS, which registers files and refreshes their contents. FreshCtx explores a narrower unit: a function or region when it can identify one.
- Its local whole-file comparison is inspired by CORVUS; it does not reproduce that paper's evaluation.
- Refreshing a function does not retract an earlier conclusion about it. That is a separate problem, and a good reason to keep claims narrow.
- Three follow-up experiments would make the evidence more useful.
- It started with an old tool result and a changed file. The useful artifact is an explicit boundary: recorded history on one side, the current source view sent to a model on the other.
- A boundary you can inspect, change, and measure.
