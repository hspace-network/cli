import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  loadCliConfig,
  updateCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  type CliConfig,
  type Provider,
  type Platform,
} from "../services/config.service.js";

interface SettingsScreenProps {
  height: number;
  width: number;
  onClose: () => void;
}

type View = "list" | "provider" | "model" | "apikey" | "platform";

type FieldId = "provider" | "model" | "apikey" | "platform";

interface Field {
  id: FieldId;
  label: string;
}

const FIELDS: Field[] = [
  { id: "provider", label: "Provider" },
  { id: "model", label: "Model" },
  { id: "apikey", label: "API Key" },
  { id: "platform", label: "Platform" },
];

function maskApiKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 4) return "*".repeat(key.length);
  return "********" + key.slice(-4);
}

function providerLabel(p: Provider): string {
  return p.label ?? p.id;
}

function platformLabel(p: Platform): string {
  return p.label ?? p.id;
}

export function SettingsScreen({ height, width, onClose }: SettingsScreenProps) {
  const [config, setConfig] = useState<CliConfig | null>(null);
  const [view, setView] = useState<View>("list");
  const [fieldIdx, setFieldIdx] = useState(0);
  const [subIdx, setSubIdx] = useState(0);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const cached = getCachedNodeConfig();
  const providers = cached?.providers ?? [];
  const platforms = cached?.platforms ?? [];
  const effective = config
    ? getEffectiveSelection(config, cached?.defaults, providers)
    : { provider: undefined, model: undefined, platform: undefined };
  const currentProvider = effective.provider
    ? providers.find((p) => p.id === effective.provider)
    : undefined;
  const models = currentProvider?.models ?? [];

  useEffect(() => {
    loadCliConfig().then((c) => setConfig(c));
  }, []);

  const persist = async (patch: Partial<CliConfig>) => {
    const next = await updateCliConfig(patch);
    setConfig(next);
  };

  useInput((input, key) => {
    if (!config) return;

    if (view === "list") {
      if (key.escape || (key.ctrl && input === "c")) {
        onClose();
        return;
      }
      if (key.upArrow) {
        setFieldIdx((i) => Math.max(0, i - 1));
        setNotice(null);
        return;
      }
      if (key.downArrow) {
        setFieldIdx((i) => Math.min(FIELDS.length - 1, i + 1));
        setNotice(null);
        return;
      }
      if (key.return) {
        const field = FIELDS[fieldIdx]!;
        setNotice(null);

        if (field.id === "provider") {
          if (providers.length === 0) {
            setNotice("Not connected to a node. Press Esc to exit, then run \"node set <url>\".");
            return;
          }
          const idx = providers.findIndex((p) => p.id === effective.provider);
          setSubIdx(idx === -1 ? 0 : idx);
          setView("provider");
          return;
        }

        if (field.id === "model") {
          if (!effective.provider) {
            setNotice("Pick a provider first.");
            return;
          }
          if (models.length === 0) {
            setNotice("Not connected to a node. Press Esc to exit, then run \"node set <url>\".");
            return;
          }
          const idx = models.findIndex((m) => m === effective.model);
          setSubIdx(idx === -1 ? 0 : idx);
          setView("model");
          return;
        }

        if (field.id === "apikey") {
          setApiKeyDraft(config.apiKey ?? "");
          setApiKeyVisible(true);
          setView("apikey");
          return;
        }

        if (field.id === "platform") {
          if (platforms.length === 0) {
            setNotice("Not connected to a node. Press Esc to exit, then run \"node set <url>\".");
            return;
          }
          const idx = platforms.findIndex((p) => p.id === effective.platform);
          setSubIdx(idx === -1 ? 0 : idx);
          setView("platform");
          return;
        }
      }
      return;
    }

    if (view === "provider") {
      if (key.escape) {
        setView("list");
        return;
      }
      if (key.upArrow) {
        setSubIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSubIdx((i) => Math.min(providers.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = providers[subIdx];
        if (!chosen) return;
        const patch: Partial<CliConfig> = { provider: chosen.id };
        const currentModel = effective.model;
        const modelStillValid =
          !!currentModel && chosen.models.includes(currentModel);
        if (!modelStillValid) {
          const fallback =
            (chosen.defaultModel && chosen.models.includes(chosen.defaultModel)
              ? chosen.defaultModel
              : undefined) ?? chosen.models[0];
          patch.model = fallback;
        }
        persist(patch).then(() => setView("list"));
        return;
      }
      return;
    }

    if (view === "model") {
      if (key.escape) {
        setView("list");
        return;
      }
      if (key.upArrow) {
        setSubIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSubIdx((i) => Math.min(models.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = models[subIdx];
        if (!chosen) return;
        persist({ model: chosen }).then(() => setView("list"));
        return;
      }
      return;
    }

    if (view === "platform") {
      if (key.escape) {
        setView("list");
        return;
      }
      if (key.upArrow) {
        setSubIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSubIdx((i) => Math.min(platforms.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = platforms[subIdx];
        if (!chosen) return;
        persist({ platform: chosen.id }).then(() => setView("list"));
        return;
      }
      return;
    }

    if (view === "apikey") {
      if (key.escape) {
        setView("list");
        return;
      }
      if (key.tab) {
        setApiKeyVisible((v) => !v);
        return;
      }
      if (key.return) {
        const trimmed = apiKeyDraft.trim();
        persist({ apiKey: trimmed.length > 0 ? trimmed : undefined }).then(() => setView("list"));
        return;
      }
      if (key.backspace || key.delete) {
        setApiKeyDraft((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        const sanitized = input.replace(/[\r\n]/g, "");
        if (sanitized) {
          setApiKeyDraft((d) => d + sanitized);
        }
        return;
      }
    }
  });

  if (!config) {
    return (
      <Box flexDirection="column" height={height} width={width} paddingX={1}>
        <Text dimColor>Loading settings...</Text>
      </Box>
    );
  }

  const renderHeader = () => (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} flexShrink={0} width={width}>
      <Text color="cyanBright" bold>SETTINGS</Text>
      <Box flexGrow={1} />
      <Text dimColor>
        {view === "list"
          ? "Up/Down move  Enter edit  Esc close"
          : view === "apikey"
            ? <Text>Type to edit  <Text color="cyan">Tab</Text> toggle mask  <Text color="cyan">Enter</Text> save  <Text color="cyan">Esc</Text> cancel</Text>
            : <Text>Up/Down move  <Text color="cyan">Enter</Text> select  <Text color="cyan">Esc</Text> back</Text>}
      </Text>
    </Box>
  );

  const renderFooter = (text: React.ReactNode) => (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexShrink={0} width={width}>
      <Text dimColor>{text}</Text>
    </Box>
  );

  const fieldValue = (id: FieldId): { text: string; isDefault: boolean; isSet: boolean } => {
    if (id === "apikey") {
      return { text: maskApiKey(config.apiKey), isDefault: false, isSet: !!config.apiKey };
    }
    if (id === "provider") {
      const effectiveValue = effective.provider;
      return {
        text: effectiveValue ?? "(not set)",
        isDefault: !config.provider && !!effectiveValue,
        isSet: !!effectiveValue,
      };
    }
    if (id === "model") {
      const effectiveValue = effective.model;
      return {
        text: effectiveValue ?? "(not set)",
        isDefault: !config.model && !!effectiveValue,
        isSet: !!effectiveValue,
      };
    }
    if (id === "platform") {
      const effectiveValue = effective.platform;
      return {
        text: effectiveValue ?? "(not set)",
        isDefault: !config.platform && !!effectiveValue,
        isSet: !!effectiveValue,
      };
    }
    return { text: "", isDefault: false, isSet: false };
  };

  if (view === "list") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {FIELDS.map((f, i) => {
            const selected = i === fieldIdx;
            const isMissingProviderForModel = f.id === "model" && !effective.provider;
            const value = fieldValue(f.id);
            return (
              <Box key={f.id}>
                <Box width={4}>
                  <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                </Box>
                <Box width={14}>
                  <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                    {f.label}
                  </Text>
                </Box>
                <Text
                  color={
                    isMissingProviderForModel
                      ? "gray"
                      : !value.isSet
                        ? "yellow"
                        : "white"
                  }
                  dimColor={!selected && value.isSet}
                >
                  {value.text}
                </Text>
                {value.isDefault ? (
                  <Text color="magenta">{"  (default)"}</Text>
                ) : null}
              </Box>
            );
          })}
          {notice ? (
            <Box marginTop={1}>
              <Text color="yellow">{notice}</Text>
            </Box>
          ) : null}
        </Box>
        {renderFooter(`Node: ${cached ? "online" : "offline"}`)}
      </Box>
    );
  }

  if (view === "provider") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>Select Provider</Text>
          <Box marginTop={1} flexDirection="column">
            {providers.map((p, i) => {
              const selected = i === subIdx;
              const current = p.id === effective.provider;
              const fromDefault = current && !config.provider;
              return (
                <Box key={p.id}>
                  <Box width={4}>
                    <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                  </Box>
                  <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                    {providerLabel(p)}
                  </Text>
                  {current ? <Text dimColor>{"  (current)"}</Text> : null}
                  {fromDefault ? <Text color="magenta">{"  (default)"}</Text> : null}
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter(`${providers.length} provider${providers.length === 1 ? "" : "s"}`)}
      </Box>
    );
  }

  if (view === "model") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>Select Model</Text>
          <Text dimColor>Provider: {effective.provider}</Text>
          <Box marginTop={1} flexDirection="column">
            {models.map((m, i) => {
              const selected = i === subIdx;
              const current = m === effective.model;
              const fromDefault = current && !config.model;
              return (
                <Box key={m}>
                  <Box width={4}>
                    <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                  </Box>
                  <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                    {m}
                  </Text>
                  {current ? <Text dimColor>{"  (current)"}</Text> : null}
                  {fromDefault ? <Text color="magenta">{"  (default)"}</Text> : null}
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter(`${models.length} model${models.length === 1 ? "" : "s"}`)}
      </Box>
    );
  }

  if (view === "platform") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>Select Platform</Text>
          <Box marginTop={1} flexDirection="column">
            {platforms.map((p, i) => {
              const selected = i === subIdx;
              const current = p.id === effective.platform;
              const fromDefault = current && !config.platform;
              return (
                <Box key={p.id}>
                  <Box width={4}>
                    <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                  </Box>
                  <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                    {platformLabel(p)}
                  </Text>
                  {current ? <Text dimColor>{"  (current)"}</Text> : null}
                  {fromDefault ? <Text color="magenta">{"  (default)"}</Text> : null}
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter(`${platforms.length} platform${platforms.length === 1 ? "" : "s"}`)}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={height} width={width}>
      {renderHeader()}
      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        <Text color="cyan" bold>Edit API Key</Text>
        <Box marginTop={1}>
          <Text dimColor>Key: </Text>
          <Text color="white">
            {apiKeyDraft.length === 0
              ? ""
              : apiKeyVisible
                ? apiKeyDraft
                : "*".repeat(apiKeyDraft.length)}
          </Text>
          <Text inverse> </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {apiKeyVisible ? "Visible (Tab to mask)" : "Masked (Tab to reveal)"}
          </Text>
        </Box>
      </Box>
      {renderFooter(<Text><Text color="cyan">Enter</Text> save  <Text color="cyan">Esc</Text> cancel  <Text color="cyan">Tab</Text> toggle mask</Text>)}
    </Box>
  );
}
