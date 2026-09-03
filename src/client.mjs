import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { PROTOCOL } from "./protocol.mjs";

export class FreshCtxClient {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#receive(line));
    child.once("error", (error) => this.#rejectAll(error));
    child.once("exit", (code, signal) => {
      if (!this.closed) this.#rejectAll(new Error(`freshctx exited (${code ?? signal ?? "unknown"})`));
    });
  }

  static spawn({ command = "freshctx", root, spawn: spawnChild = spawn } = {}) {
    if (!root) throw new TypeError("root is required");
    return new FreshCtxClient(spawnChild(command, ["serve", "--stdio", "--root", root], {
      stdio: ["pipe", "pipe", "pipe"],
    }));
  }

  #receive(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.#rejectAll(new Error("freshctx emitted invalid JSONL"));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else {
      const error = new Error(response.error?.message ?? "freshctx request failed");
      error.code = response.error?.code;
      error.details = response.error?.details;
      pending.reject(error);
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(op, fields = {}) {
    if (this.closed) return Promise.reject(new Error("freshctx client is closed"));
    const id = `rpc_${++this.nextId}`;
    const request = { protocol: PROTOCOL, id, op, ...fields };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.#rejectAll(new Error("freshctx client closed"));
  }
}
