import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { CommandHistory } from "../utils/history.js";

interface InputPromptProps {
  onSubmit: (value: string) => void;
  confirmPrompt?: string | null;
  isDisabled?: boolean;
  history: CommandHistory;
  suggestions?: string[];
}

const ASK_PREFIX = "/ask";

function isAskPrefix(value: string): boolean {
  if (!value.toLowerCase().startsWith(ASK_PREFIX)) return false;
  return value.length === ASK_PREFIX.length || value[ASK_PREFIX.length] === " ";
}

function renderHighlightedSlice(slice: string, fullValue: string, sliceStart: number): React.ReactNode {
  if (!isAskPrefix(fullValue)) {
    return slice;
  }

  const cyanEnd = ASK_PREFIX.length;
  const sliceEnd = sliceStart + slice.length;

  if (sliceEnd <= cyanEnd) {
    return <Text color="cyan">{slice}</Text>;
  }
  if (sliceStart >= cyanEnd) {
    return slice;
  }

  const cyanPart = slice.slice(0, cyanEnd - sliceStart);
  const restPart = slice.slice(cyanEnd - sliceStart);
  return (
    <>
      <Text color="cyan">{cyanPart}</Text>
      {restPart}
    </>
  );
}

export function InputPrompt({
  onSubmit,
  confirmPrompt,
  isDisabled,
  history,
  suggestions,
}: InputPromptProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  const reset = useCallback(() => {
    setValue("");
    setCursor(0);
  }, []);

  const setBoth = useCallback((next: string, nextCursor?: number) => {
    setValue(next);
    setCursor(nextCursor ?? next.length);
  }, []);

  useEffect(() => {
    reset();
  }, [confirmPrompt, reset]);

  useInput(
    (input, key) => {
      if (isDisabled) return;

      if (key.return) {
        if (!confirmPrompt && value.trim()) {
          history.push(value.trim());
        }
        history.reset();
        const submitted = value;
        reset();
        onSubmit(submitted);
        return;
      }

      if (key.upArrow) {
        if (confirmPrompt) return;
        const prev = history.prev(value);
        if (prev !== undefined) setBoth(prev);
        return;
      }
      if (key.downArrow) {
        if (confirmPrompt) return;
        const next = history.next();
        if (next !== undefined) setBoth(next);
        return;
      }

      if (key.tab && !key.shift && !confirmPrompt && suggestions && value.length > 0) {
        const match = suggestions.find((s) => s.startsWith(value));
        if (match && match !== value) setBoth(match);
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        setBoth(next, cursor - 1);
        return;
      }

      if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.escape
      ) {
        const sanitized = input.replace(/[\r\n]/g, "");
        if (!sanitized) return;
        const next = value.slice(0, cursor) + sanitized + value.slice(cursor);
        setBoth(next, cursor + sanitized.length);
      }
    },
    { isActive: !isDisabled },
  );

  if (confirmPrompt) {
    const before = value.slice(0, cursor);
    const at = value.slice(cursor, cursor + 1) || " ";
    const after = value.slice(cursor + 1);
    return (
      <Box>
        <Text color="cyan">{confirmPrompt + " "}</Text>
        <Text>{before}</Text>
        <Text inverse>{at}</Text>
        <Text>{after}</Text>
      </Box>
    );
  }

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);

  const cursorIsAsk = isAskPrefix(value) && cursor < ASK_PREFIX.length;

  const ghost =
    cursor === value.length && value.length > 0 && suggestions
      ? suggestions.find((s) => s.startsWith(value) && s !== value)
      : undefined;
  const ghostSuffix = ghost ? ghost.slice(value.length) : "";

  return (
    <Box>
      <Text color="cyan">agent </Text>
      <Text bold>{"> "}</Text>
      <Text>{renderHighlightedSlice(before, value, 0)}</Text>
      <Text inverse color={cursorIsAsk ? "cyan" : undefined}>{at}</Text>
      <Text>{renderHighlightedSlice(after, value, cursor + 1)}</Text>
      {ghostSuffix ? <Text dimColor>{ghostSuffix}</Text> : null}
    </Box>
  );
}
