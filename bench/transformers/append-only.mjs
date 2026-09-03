export function transformAppendOnly({ observations, arm = "append_only" }) {
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
    arm,
    history,
    liveBlock: "",
    selected,
    workingSetSize: history.length,
    compact_calls: 0,
    prune_commits: 0,
  };
}
