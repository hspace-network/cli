import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Editor } from "./Editor.js";
import {
  listScripts,
  deleteScript,
  runScript,
  scriptFilePath,
  type ScriptMeta,
  type SandboxResult,
} from "../services/sandbox.service.js";

interface ScriptsScreenProps {
  height: number;
  width: number;
  agentName: string;
  onClose: () => void;
  onSaved?: (message: string) => void;
}

interface EditingState {
  filePath: string;
  fileName: string;
}

function summarize(res: SandboxResult, max = 600): string {
  if (!res.ok) {
    const err = res.error ?? res.stderr ?? "run failed";
    return err.length > max ? err.slice(0, max) + "…" : err;
  }
  let out: string;
  try {
    out = typeof res.result === "string" ? res.result : JSON.stringify(res.result);
  } catch {
    out = String(res.result);
  }
  out = out ?? "undefined";
  const head = res.signal ? `signal=${res.signal.bias} ` : "";
  const body = out.length > max ? out.slice(0, max) + "…" : out;
  return `${head}${body}`;
}

export function ScriptsScreen({ height, width, agentName, onClose, onSaved }: ScriptsScreenProps) {
  const [entries, setEntries] = useState<ScriptMeta[]>([]);
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("info");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const list = await listScripts(agentName);
    setEntries(list);
    setIdx((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  useInput((input, key) => {
    if (editing || running) return;

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      setPendingDelete(null);
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(entries.length - 1, i + 1));
      setPendingDelete(null);
      return;
    }

    const entry = entries[idx];

    if (key.return && entry) {
      setEditing({ filePath: scriptFilePath(agentName, entry.name), fileName: `${entry.name}.ts` });
      setNotice(null);
      setPendingDelete(null);
      return;
    }

    if ((input === "d" || input === "D") && entry) {
      if (pendingDelete === entry.name) {
        void (async () => {
          try {
            await deleteScript(agentName, entry.name);
            setPendingDelete(null);
            setNoticeTone("success");
            setNotice(`Deleted "${entry.name}".`);
            await refresh();
          } catch (err) {
            setNoticeTone("error");
            setNotice((err as Error).message);
          }
        })();
      } else {
        setPendingDelete(entry.name);
        setNoticeTone("info");
        setNotice(`Press d again to delete "${entry.name}".`);
      }
      return;
    }

    if ((input === "r" || input === "R") && entry) {
      setPendingDelete(null);
      setRunning(true);
      setNoticeTone("info");
      setNotice(`Running "${entry.name}"…`);
      void (async () => {
        try {
          const res = await runScript({ agent: agentName, name: entry.name });
          setNoticeTone(res.ok ? "success" : "error");
          setNotice(`${entry.name} (${res.durationMs}ms): ${summarize(res)}`);
        } catch (err) {
          setNoticeTone("error");
          setNotice((err as Error).message);
        } finally {
          setRunning(false);
        }
      })();
      return;
    }
  });

  if (editing) {
    return (
      <Editor
        filePath={editing.filePath}
        fileName={editing.fileName}
        height={height}
        onSave={() => {
          setEditing(null);
          void refresh();
          const msg = `Saved ${editing.fileName}.`;
          setNoticeTone("success");
          setNotice(msg);
          onSaved?.(msg);
        }}
        onCancel={() => {
          setEditing(null);
        }}
      />
    );
  }

  const bodyHeight = Math.max(1, height - 6);
  const start = Math.max(
    0,
    Math.min(idx - Math.floor(bodyHeight / 2), Math.max(0, entries.length - bodyHeight)),
  );
  const visible = entries.slice(start, start + bodyHeight);

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} flexShrink={0} width={width}>
        <Text color="cyanBright" bold>
          SCRIPTS
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>↑↓ select  Enter edit  r run  d delete  Esc close</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text>
            <Text dimColor>Sandbox scripts for </Text>
            <Text color="cyanBright" bold>
              {agentName}
            </Text>
          </Text>
        </Box>
        {loading ? (
          <Text dimColor>Loading scripts…</Text>
        ) : entries.length === 0 ? (
          <Text dimColor>
            {`No saved scripts yet. Agents create these during research, or run "code ${agentName} <prompt>".`}
          </Text>
        ) : (
          visible.map((entry, i) => {
            const absoluteIdx = start + i;
            const selected = absoluteIdx === idx;
            const date = entry.updatedAt ? entry.updatedAt.split("T")[0] : "";
            const marker = selected ? "> " : "  ";
            const innerWidth = Math.max(20, width - 4);
            const left = `${marker}${entry.name}`;
            const maxLeft = Math.max(0, innerWidth - date.length - 1);
            const leftClipped =
              left.length > maxLeft ? `${left.slice(0, Math.max(0, maxLeft - 1))}…` : left;
            const gap = Math.max(1, innerWidth - leftClipped.length - date.length);
            const lineText = `${leftClipped}${" ".repeat(gap)}${date}`;
            return (
              <Text
                key={entry.name}
                color={selected ? "cyanBright" : undefined}
                bold={selected}
                dimColor={!selected}
              >
                {lineText}
              </Text>
            );
          })
        )}
        {notice ? (
          <Box marginTop={1}>
            <Text
              color={
                noticeTone === "error" ? "yellow" : noticeTone === "success" ? "green" : "cyan"
              }
            >
              {notice}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
