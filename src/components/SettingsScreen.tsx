import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  loadCliConfig,
  updateCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  getEffectiveNetwork,
  getEffectiveChain,
  validateChainNetworkPair,
  getProviderApiKey,
  getPlatformCreds,
  type CliConfig,
  type BybitNetwork,
  type ChainId,
  type Provider,
  type Platform,
} from "../services/config.service.js";

interface SettingsScreenProps {
  height: number;
  width: number;
  onClose: () => void;
}

type View =
  | "list"
  | "provider"
  | "providerkey"
  | "model"
  | "platform"
  | "platformcreds"
  | "network"
  | "chain";

type FieldId = "provider" | "model" | "platform" | "network" | "chain";

interface Field {
  id: FieldId;
  label: string;
}

const FIELDS: Field[] = [
  { id: "provider", label: "Provider" },
  { id: "model", label: "Model" },
  { id: "platform", label: "Platform" },
  { id: "network", label: "Network" },
  { id: "chain", label: "Chain" },
];

const NETWORKS: { id: BybitNetwork; label: string }[] = [
  { id: "mainnet", label: "mainnet" },
  { id: "testnet", label: "testnet" },
];

const CHAINS: { id: ChainId; label: string }[] = [
  { id: "mantle", label: "mantle" },
  { id: "mantle-sepolia", label: "mantle-sepolia" },
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
  const [notice, setNotice] = useState<string | null>(null);

  // provider key editing
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [providerKeyDraft, setProviderKeyDraft] = useState("");
  const [providerKeyVisible, setProviderKeyVisible] = useState(true);

  // platform creds editing
  const [pendingPlatform, setPendingPlatform] = useState<string | null>(null);
  const [platformKeyDraft, setPlatformKeyDraft] = useState("");
  const [platformSecretDraft, setPlatformSecretDraft] = useState("");
  const [platformFieldIdx, setPlatformFieldIdx] = useState(0);

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

  const saveProviderKey = () => {
    if (!config || !pendingProvider) return;
    const trimmed = providerKeyDraft.trim();
    const nextApiKeys = { ...(config.apiKeys ?? {}) };
    if (trimmed) nextApiKeys[pendingProvider] = trimmed;
    else delete nextApiKeys[pendingProvider];

    const patch: Partial<CliConfig> = {
      provider: pendingProvider,
      apiKeys: nextApiKeys,
    };
    const chosen = providers.find((p) => p.id === pendingProvider);
    const currentModel = effective.model;
    const modelStillValid =
      !!currentModel && !!chosen && chosen.models.includes(currentModel);
    if (chosen && !modelStillValid) {
      patch.model =
        (chosen.defaultModel && chosen.models.includes(chosen.defaultModel)
          ? chosen.defaultModel
          : undefined) ?? chosen.models[0];
    }
    persist(patch).then(() => setView("list"));
  };

  const savePlatformCreds = () => {
    if (!config || !pendingPlatform) return;
    const apiKey = platformKeyDraft.trim();
    const apiSecret = platformSecretDraft.trim();
    if (!apiKey || !apiSecret) {
      setNotice("Both API key and secret are required to select this platform.");
      return;
    }
    const nextPlatformKeys = {
      ...(config.platformKeys ?? {}),
      [pendingPlatform]: { apiKey, apiSecret },
    };
    persist({ platform: pendingPlatform, platformKeys: nextPlatformKeys }).then(() =>
      setView("list"),
    );
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

        if (field.id === "network") {
          const idx = NETWORKS.findIndex((n) => n.id === getEffectiveNetwork(config));
          setSubIdx(idx === -1 ? 0 : idx);
          setView("network");
          return;
        }

        if (field.id === "chain") {
          const idx = CHAINS.findIndex((c) => c.id === getEffectiveChain(config));
          setSubIdx(idx === -1 ? 0 : idx);
          setView("chain");
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
        setPendingProvider(chosen.id);
        setProviderKeyDraft(getProviderApiKey(config, chosen.id) ?? "");
        setProviderKeyVisible(true);
        setView("providerkey");
        return;
      }
      return;
    }

    if (view === "providerkey") {
      if (key.escape) {
        setView("provider");
        return;
      }
      if (key.tab) {
        setProviderKeyVisible((v) => !v);
        return;
      }
      if (key.return) {
        saveProviderKey();
        return;
      }
      if (key.backspace || key.delete) {
        setProviderKeyDraft((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        const sanitized = input.replace(/[\r\n]/g, "");
        if (sanitized) setProviderKeyDraft((d) => d + sanitized);
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
        const creds = getPlatformCreds(config, chosen.id);
        setPendingPlatform(chosen.id);
        setPlatformKeyDraft(creds?.apiKey ?? "");
        setPlatformSecretDraft(creds?.apiSecret ?? "");
        setPlatformFieldIdx(0);
        setNotice(null);
        setView("platformcreds");
        return;
      }
      return;
    }

    if (view === "platformcreds") {
      if (key.escape) {
        setNotice(null);
        setView("platform");
        return;
      }
      if (key.tab || key.upArrow || key.downArrow) {
        setPlatformFieldIdx((i) => (i === 0 ? 1 : 0));
        return;
      }
      if (key.return) {
        if (platformFieldIdx === 0) {
          setPlatformFieldIdx(1);
          return;
        }
        savePlatformCreds();
        return;
      }
      if (key.backspace || key.delete) {
        if (platformFieldIdx === 0) setPlatformKeyDraft((d) => d.slice(0, -1));
        else setPlatformSecretDraft((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        const sanitized = input.replace(/[\r\n]/g, "");
        if (sanitized) {
          if (platformFieldIdx === 0) setPlatformKeyDraft((d) => d + sanitized);
          else setPlatformSecretDraft((d) => d + sanitized);
        }
        return;
      }
      return;
    }

    if (view === "network") {
      if (key.escape) {
        setView("list");
        return;
      }
      if (key.upArrow) {
        setSubIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSubIdx((i) => Math.min(NETWORKS.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = NETWORKS[subIdx];
        if (!chosen) return;
        const pairErr = validateChainNetworkPair(getEffectiveChain(config), chosen.id);
        if (pairErr) {
          setNotice(pairErr);
          return;
        }
        persist({ network: chosen.id }).then(() => setView("list"));
        return;
      }
      return;
    }

    if (view === "chain") {
      if (key.escape) {
        setView("list");
        return;
      }
      if (key.upArrow) {
        setSubIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSubIdx((i) => Math.min(CHAINS.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = CHAINS[subIdx];
        if (!chosen) return;
        const pairErr = validateChainNetworkPair(chosen.id, getEffectiveNetwork(config));
        if (pairErr) {
          setNotice(pairErr);
          return;
        }
        persist({ chain: chosen.id }).then(() => setView("list"));
        return;
      }
      return;
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
          : view === "providerkey"
            ? <Text>Type to edit  <Text color="cyan">Tab</Text> toggle mask  <Text color="cyan">Enter</Text> save  <Text color="cyan">Esc</Text> back</Text>
            : view === "platformcreds"
              ? <Text>Type to edit  <Text color="cyan">Tab</Text> switch field  <Text color="cyan">Enter</Text> next/save  <Text color="cyan">Esc</Text> back</Text>
              : <Text>Up/Down move  <Text color="cyan">Enter</Text> select  <Text color="cyan">Esc</Text> back</Text>}
      </Text>
    </Box>
  );

  const renderFooter = (text: React.ReactNode) => (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexShrink={0} width={width}>
      <Text dimColor>{text}</Text>
    </Box>
  );

  const fieldValue = (
    id: FieldId,
  ): { text: string; isDefault: boolean; isSet: boolean; suffix?: string } => {
    if (id === "provider") {
      const effectiveValue = effective.provider;
      const hasKey = !!getProviderApiKey(config, effectiveValue);
      return {
        text: effectiveValue ?? "(not set)",
        isDefault: !config.provider && !!effectiveValue,
        isSet: !!effectiveValue,
        suffix: effectiveValue ? (hasKey ? "key set" : "no key") : undefined,
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
      const hasKey = !!getPlatformCreds(config, effectiveValue);
      return {
        text: effectiveValue ?? "(not set)",
        isDefault: !config.platform && !!effectiveValue,
        isSet: !!effectiveValue && hasKey,
        suffix: effectiveValue ? (hasKey ? "key set" : "no key") : undefined,
      };
    }
    if (id === "network") {
      const value = getEffectiveNetwork(config);
      return {
        text: value,
        isDefault: !config.network,
        isSet: true,
      };
    }
    if (id === "chain") {
      const value = getEffectiveChain(config);
      return {
        text: value,
        isDefault: !config.chain,
        isSet: true,
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
                {value.suffix ? (
                  <Text color={value.suffix === "no key" ? "yellow" : "green"}>
                    {"  " + value.suffix}
                  </Text>
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
              const hasKey = !!getProviderApiKey(config, p.id);
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
                  <Text color={hasKey ? "green" : "yellow"}>{hasKey ? "  key set" : "  no key"}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter(`${providers.length} provider${providers.length === 1 ? "" : "s"}  —  Enter to set its API key`)}
      </Box>
    );
  }

  if (view === "providerkey") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>API Key</Text>
          <Text dimColor>Provider: {pendingProvider}</Text>
          <Box marginTop={1}>
            <Text dimColor>Key: </Text>
            <Text color="white">
              {providerKeyDraft.length === 0
                ? ""
                : providerKeyVisible
                  ? providerKeyDraft
                  : "*".repeat(providerKeyDraft.length)}
            </Text>
            <Text inverse> </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {providerKeyVisible ? "Visible (Tab to mask)" : "Masked (Tab to reveal)"}
            </Text>
          </Box>
        </Box>
        {renderFooter(<Text><Text color="cyan">Enter</Text> save  <Text color="cyan">Esc</Text> back  <Text color="cyan">Tab</Text> toggle mask</Text>)}
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
              const hasKey = !!getPlatformCreds(config, p.id);
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
                  <Text color={hasKey ? "green" : "yellow"}>{hasKey ? "  key set" : "  no key"}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter("Enter to set its API key + secret (required)")}
      </Box>
    );
  }

  if (view === "platformcreds") {
    const renderField = (label: string, value: string, active: boolean) => (
      <Box marginTop={1}>
        <Box width={10}>
          <Text color={active ? "cyanBright" : "white"} bold={active}>{label}</Text>
        </Box>
        <Text color="white">
          {value.length === 0
            ? ""
            : active
              ? value
              : "********" + (value.length > 4 ? value.slice(-4) : "")}
        </Text>
        {active ? <Text inverse> </Text> : null}
      </Box>
    );
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>{pendingPlatform} Credentials</Text>
          <Text dimColor>Both fields are required to use this platform.</Text>
          {renderField("API key", platformKeyDraft, platformFieldIdx === 0)}
          {renderField("Secret", platformSecretDraft, platformFieldIdx === 1)}
          {notice ? (
            <Box marginTop={1}>
              <Text color="yellow">{notice}</Text>
            </Box>
          ) : null}
        </Box>
        {renderFooter(<Text><Text color="cyan">Tab</Text> switch field  <Text color="cyan">Enter</Text> next/save  <Text color="cyan">Esc</Text> back</Text>)}
      </Box>
    );
  }

  if (view === "network") {
    const currentNetwork = getEffectiveNetwork(config);
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>Select Bybit Network</Text>
          <Text dimColor>Trade commands hit this network.</Text>
          <Box marginTop={1} flexDirection="column">
            {NETWORKS.map((n, i) => {
              const selected = i === subIdx;
              const current = n.id === currentNetwork;
              const fromDefault = current && !config.network;
              return (
                <Box key={n.id}>
                  <Box width={4}>
                    <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                  </Box>
                  <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                    {n.label}
                  </Text>
                  {current ? <Text dimColor>{"  (current)"}</Text> : null}
                  {fromDefault ? <Text color="magenta">{"  (default)"}</Text> : null}
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter("Default: mainnet")}
      </Box>
    );
  }

  if (view === "chain") {
    const currentChain = getEffectiveChain(config);
    return (
      <Box flexDirection="column" height={height} width={width}>
        {renderHeader()}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>Select Chain</Text>
          <Text dimColor>MNT deposits and withdrawals use this chain.</Text>
          <Box marginTop={1} flexDirection="column">
            {CHAINS.map((c, i) => {
              const selected = i === subIdx;
              const current = c.id === currentChain;
              const fromDefault = current && !config.chain;
              return (
                <Box key={c.id}>
                  <Box width={4}>
                    <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                  </Box>
                  <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                    {c.label}
                  </Text>
                  {current ? <Text dimColor>{"  (current)"}</Text> : null}
                  {fromDefault ? <Text color="magenta">{"  (default)"}</Text> : null}
                </Box>
              );
            })}
          </Box>
        </Box>
        {renderFooter("Default: mantle — pair mantle-sepolia with testnet")}
      </Box>
    );
  }

  return null;
}
