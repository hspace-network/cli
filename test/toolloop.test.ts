import { describe, it, expect } from "vitest";
import {
  runToolLoop,
  __setLlmClients,
  type ToolLoopArgs,
} from "../src/services/llm.service.js";
import type { ToolSpec } from "../src/services/tools.service.js";

function echoTool(calls: string[]): ToolSpec {
  return {
    name: "echo",
    description: "echo back",
    parameters: { type: "object", properties: {} },
    handler: async (a) => {
      calls.push(JSON.stringify(a));
      return { ok: true, echoed: a };
    },
  };
}

/** Minimal OpenAI-compatible client mock (covers both OpenAI and z.ai paths). */
function mockOpenAI(responses: Array<unknown | (() => never)>) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          if (params.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: "fallback-text" } }] };
            })();
          }
          const r = responses[i++];
          if (typeof r === "function") (r as () => never)();
          return r;
        },
      },
    },
  } as any;
}

function baseArgs(tools: ToolSpec[]): ToolLoopArgs {
  return {
    provider: "z.ai", // routes through the OpenAI-compatible loop
    model: "glm-4.6",
    apiKey: "test",
    system: "sys",
    userMessage: "go",
    tools,
    maxIters: 4,
    maxMs: 10_000,
  };
}

describe("runToolLoop tool calling", () => {
  it("executes tool calls for an OpenAI-compatible provider (z.ai)", async () => {
    const calls: string[] = [];
    __setLlmClients({
      openai: () =>
        mockOpenAI([
          {
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "echo", arguments: '{"x":1}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ message: { content: "done" } }] },
        ]),
    });

    const res = await runToolLoop(baseArgs([echoTool(calls)]));
    expect(res.toolsUsed).toBe(true);
    expect(res.toolCalls).toBe(1);
    expect(calls).toEqual(['{"x":1}']);
    expect(res.text).toContain("done");
  });

  it("propagates real errors instead of silently degrading", async () => {
    __setLlmClients({
      openai: () =>
        mockOpenAI([
          () => {
            throw Object.assign(new Error("internal server error"), { status: 500 });
          },
        ]),
    });
    await expect(runToolLoop(baseArgs([echoTool([])]))).rejects.toThrow(
      /internal server error/,
    );
  });

  it("degrades to text only when the model truly rejects tools", async () => {
    __setLlmClients({
      openai: () =>
        mockOpenAI([
          () => {
            throw Object.assign(
              new Error("tools is not supported by this model"),
              { status: 400 },
            );
          },
        ]),
    });
    const res = await runToolLoop(baseArgs([echoTool([])]));
    expect(res.toolsUsed).toBe(false);
    expect(res.text).toContain("fallback-text");
  });
});
