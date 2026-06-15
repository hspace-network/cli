import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { readFile } from "node:fs/promises";
import { Editor } from "./Editor.js";
import {
  listAllStrategies,
  prepareStrategyEdit,
  forkBuiltinStrategy,
  cleanupStrategyDraft,
  setAgentStrategy,
  renameUserStrategy,
  type StrategyEntry,
} from "../services/strategy.service.js";
import { getAgent } from "../services/agent.service.js";

interface StrategyScreenProps {
  height: number;
  width: number;
  activeAgent: string | null;
  onClose: () => void;
  onSaved?: (message: string) => void;
}

interface EditingState {
  filePath: string;
  fileName: string;
  isBuiltin: boolean;
  builtinId?: string;
}

export function StrategyScreen({ height, width, activeAgent, onClose, onSaved }: StrategyScreenProps) {
  const [entries, setEntries] = useState<StrategyEntry[]>([]);
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"success" | "error">("success");
  const [assignedId, setAssignedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const refresh = async () => {
    const list = await listAllStrategies();
    setEntries(list);
    setIdx((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!activeAgent) {
        setAssignedId(null);
        return;
      }
      try {
        const agent = await getAgent(activeAgent);
        if (!cancelled) setAssignedId(agent.strategyId ?? null);
      } catch {
        if (!cancelled) setAssignedId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAgent]);

  useInput((input, key) => {
    if (editing) return;

    if (renaming) {
      if (key.escape) {
        setRenaming(false);
        return;
      }
      if (key.return) {
        const entry = entries[idx];
        if (!entry) {
          setRenaming(false);
          return;
        }
        const value = renameValue;
        void (async () => {
          try {
            const newId = await renameUserStrategy(entry.id, value);
            setRenaming(false);
            await refresh();
            if (assignedId === entry.id) setAssignedId(newId);
            setNoticeTone("success");
            setNotice(`Renamed to "${value.trim()}" (${newId}).`);
          } catch (err) {
            setRenaming(false);
            setNoticeTone("error");
            setNotice((err as Error).message);
          }
        })();
        return;
      }
      if (key.backspace || key.delete) {
        setRenameValue((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        const sanitized = input.replace(/[\r\n]/g, "");
        if (sanitized) setRenameValue((d) => d + sanitized);
        return;
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(entries.length - 1, i + 1));
      return;
    }
    if (input === " " && entries.length > 0) {
      const entry = entries[idx];
      if (!entry) return;
      if (!activeAgent) {
        setNoticeTone("error");
        setNotice('No active agent — run "use <agent>" first to assign a strategy.');
        return;
      }
      void (async () => {
        try {
          await setAgentStrategy(activeAgent, entry.id);
          setAssignedId(entry.id);
          setNoticeTone("success");
          setNotice(`${activeAgent} now uses "${entry.label}" (${entry.id}).`);
        } catch (err) {
          setNoticeTone("error");
          setNotice((err as Error).message);
        }
      })();
      return;
    }
    if (input === "r" && entries.length > 0) {
      const entry = entries[idx];
      if (!entry) return;
      if (entry.source !== "user") {
        setNoticeTone("error");
        setNotice("Only your own strategies can be renamed. Press Enter on a builtin to save your own copy first.");
        return;
      }
      setRenameValue(entry.label);
      setRenaming(true);
      setNotice(null);
      return;
    }
    if (key.return && entries.length > 0) {
      const entry = entries[idx];
      if (!entry) return;
      void (async () => {
        const prep = await prepareStrategyEdit(entry);
        setEditing({
          filePath: prep.filePath,
          fileName: prep.fileName,
          isBuiltin: prep.isBuiltin,
          builtinId: prep.builtinId,
        });
        setNotice(null);
      })();
    }
  });

  if (editing) {
    return (
      <Editor
        filePath={editing.filePath}
        fileName={editing.fileName}
        height={height}
        onSave={() => {
          void (async () => {
            if (editing.isBuiltin && editing.builtinId) {
              const content = await readFile(editing.filePath, "utf-8");
              const newId = await forkBuiltinStrategy(editing.builtinId, content);
              await cleanupStrategyDraft(editing.builtinId);
              setEditing(null);
              await refresh();
              const msg = `Saved as user strategy "${newId}".`;
              setNoticeTone("success");
              setNotice(msg);
              onSaved?.(msg);
            } else {
              setEditing(null);
              await refresh();
              const msg = "Strategy saved.";
              setNoticeTone("success");
              setNotice(msg);
              onSaved?.(msg);
            }
          })();
        }}
        onCancel={() => {
          if (editing.isBuiltin && editing.builtinId) {
            void cleanupStrategyDraft(editing.builtinId);
          }
          setEditing(null);
        }}
      />
    );
  }

  const bodyHeight = Math.max(1, height - 6);

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} flexShrink={0} width={width}>
        <Text color="cyanBright" bold>STRATEGIES</Text>
        <Box flexGrow={1} />
        <Text dimColor>↑↓ select  Space assign  Enter edit  r rename  Esc close</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          {activeAgent ? (
            <Text>
              <Text dimColor>Assigning to </Text>
              <Text color="cyanBright" bold>{activeAgent}</Text>
              <Text dimColor> — press Space to set the highlighted strategy</Text>
            </Text>
          ) : (
            <Text dimColor>{'No active agent — run "use <agent>" to assign a strategy.'}</Text>
          )}
        </Box>
        {renaming ? (
          <Box marginBottom={1}>
            <Text color="cyanBright">New name: </Text>
            <Text>{renameValue}</Text>
            <Text color="cyanBright">▏</Text>
          </Box>
        ) : null}
        {loading ? (
          <Text dimColor>Loading strategies...</Text>
        ) : entries.length === 0 ? (
          <Text dimColor>No strategies available. Connect to a node to load builtins.</Text>
        ) : (
          (() => {
            const start = Math.max(0, Math.min(idx - Math.floor(bodyHeight / 2), entries.length - bodyHeight));
            return entries.slice(start, start + bodyHeight);
          })().map((entry, i) => {
            const absoluteIdx = Math.max(0, Math.min(idx - Math.floor(bodyHeight / 2), entries.length - bodyHeight)) + i;
            const selected = absoluteIdx === idx;
            const assigned = entry.id === assignedId;
            const tag = entry.source === "builtin" ? "[builtin]" : "[user]   ";
            const color = selected ? "cyanBright" : assigned ? "green" : undefined;
            return (
              <Text
                key={`${entry.source}-${entry.id}`}
                color={color}
                bold={selected || assigned}
                dimColor={!selected && !assigned}
              >
                {selected ? "> " : "  "}
                {tag} {entry.label} ({entry.id})
                {assigned ? <Text color="green" bold>{"  ● in use"}</Text> : ""}
              </Text>
            );
          })
        )}
        {notice ? (
          <Box marginTop={1}>
            <Text color={noticeTone === "error" ? "yellow" : "green"}>{notice}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
