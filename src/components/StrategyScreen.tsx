import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { readFile } from "node:fs/promises";
import { Editor } from "./Editor.js";
import {
  listAllStrategies,
  prepareStrategyEdit,
  forkBuiltinStrategy,
  cleanupStrategyDraft,
  type StrategyEntry,
} from "../services/strategy.service.js";

interface StrategyScreenProps {
  height: number;
  width: number;
  onClose: () => void;
  onSaved?: (message: string) => void;
}

interface EditingState {
  filePath: string;
  fileName: string;
  isBuiltin: boolean;
  builtinId?: string;
}

export function StrategyScreen({ height, width, onClose, onSaved }: StrategyScreenProps) {
  const [entries, setEntries] = useState<StrategyEntry[]>([]);
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const list = await listAllStrategies();
    setEntries(list);
    setIdx((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  useInput((_input, key) => {
    if (editing) return;

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
              setNotice(msg);
              onSaved?.(msg);
            } else {
              setEditing(null);
              await refresh();
              const msg = "Strategy saved.";
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
        <Text dimColor>↑↓ select  Enter edit  Esc close</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
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
            const tag = entry.source === "builtin" ? "[builtin]" : "[user]   ";
            return (
              <Text
                key={`${entry.source}-${entry.id}`}
                color={selected ? "cyanBright" : undefined}
                bold={selected}
                dimColor={!selected}
              >
                {selected ? "> " : "  "}
                {tag} {entry.label} ({entry.id})
              </Text>
            );
          })
        )}
        {notice ? (
          <Box marginTop={1}>
            <Text color="green">{notice}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
