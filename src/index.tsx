#!/usr/bin/env node

import React from "react";

if (process.argv[2] === "__agent-runner") {
  // Headless background runner spawned by the `auto` command — no TUI.
  const { runAgentDaemon } = await import("./agent-daemon.js");
  await runAgentDaemon(process.argv[3]!, process.argv[4]!);
} else {
  const { withFullScreen } = await import("fullscreen-ink");
  const { App } = await import("./components/App.js");
  const ink = withFullScreen(<App />, { exitOnCtrlC: false });
  await ink.start();
  await ink.waitUntilExit();
}
