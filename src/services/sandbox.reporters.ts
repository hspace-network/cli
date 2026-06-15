/**
 * Maps sandbox tool calls to discussion "code" events so the logs screen shows
 * an agent writing and running code (with output) during research and at
 * decision time. Shared by the background scheduler and the live vote handler.
 */
import {
  emitDiscussionEvent,
  type CodeAction,
} from "./discussion.bus.js";

function clip(value: unknown, max = 280): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export interface CodeReporters {
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: unknown) => void;
}

export function makeCodeReporters(agentName: string, roomId: string): CodeReporters {
  const lastArgs = new Map<string, Record<string, unknown>>();
  const emit = (
    action: CodeAction,
    detail: string,
    ok?: boolean,
    output?: string,
  ) => emitDiscussionEvent({ type: "code", roomId, agentName, action, detail, ok, output });

  return {
    onToolCall: (name, args) => {
      lastArgs.set(name, args);
      if (name === "save_script") emit("write", `wrote script ${clip(args.name, 40)}`);
      if (name === "install_package") emit("install", `installing ${clip(args.name, 40)}`);
    },
    onToolResult: (name, result) => {
      const r = (result ?? {}) as {
        ok?: boolean;
        error?: string;
        stdout?: string;
        result?: string;
      };
      const args = lastArgs.get(name) ?? {};
      if (name === "run_code" || name === "run_script") {
        const label = name === "run_script" ? `ran script ${clip(args.name, 40)}` : "ran code";
        const out = r.ok === false ? r.error : r.result ?? r.stdout;
        emit("run", label, r.ok !== false, clip(out));
      } else if (name === "install_package") {
        emit("install", `installed ${clip(args.name, 40)}`, r.ok !== false);
      } else if (name === "set_signal") {
        emit("signal", "emitted signal", true, clip(r.result));
      }
    },
  };
}
