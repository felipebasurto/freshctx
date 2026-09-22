import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { PROTOCOL } from "./protocol.mjs";

const CLI = fileURLToPath(new URL("../bin/freshctx.mjs", import.meta.url));

export class Client {
  constructor({ root, timeoutMs = 10000, command = process.execPath, args = [CLI, "serve", "--stdio", "--root", root] } = {}) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.sequence = 0;
    this.timeoutMs = timeoutMs;
    this.failure = null;
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("FreshCtx process exited")));
    this.lines.on("line", (line) => {
      try {
        const reply = JSON.parse(line);
        if (reply.protocol !== PROTOCOL || typeof reply.ok !== "boolean") throw new Error("Invalid FreshCtx response");
        const pending = this.pending.get(reply.id);
        if (!pending) throw new Error("Unexpected FreshCtx response ID");
        clearTimeout(pending.timer);
        this.pending.delete(reply.id);
        if (reply.ok) pending.resolve(reply.result);
        else pending.reject(Object.assign(new Error(reply.error?.message ?? "FreshCtx rejected request"), { code: reply.error?.code }));
      } catch (error) {
        this.fail(error);
      }
    });
  }

  fail(error, kill = true) {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    if (kill) this.child.kill();
  }

  request(op, fields = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("FreshCtx request timed out")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...fields, protocol: PROTOCOL, id, op })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async close() {
    this.fail(new Error("FreshCtx client closed"), false);
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      this.lines.close();
    }
  }
}
