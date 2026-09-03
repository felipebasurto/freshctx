export function transformAppendOnly({ observations }) {
  const history = observations.map((obs) => ({
    kind: "body",
    resultId: obs.resultId,
    path: obs.path,
    text: obs.text,
  }));
  const selected = observations.map((obs) => ({
    path: obs.path,
    kind: "file",
    content: obs.text,
  }));
  return {
    arm: "append_only",
    history,
    liveBlock: "",
    selected,
    workingSetSize: history.length,
  };
}
