import {
  getAgentsRoot,
  getCliConfigPath,
  ensureDir,
  fileExists,
  readJson,
  writeJson,
} from "../utils/fs.js";

export interface Room {
  id: string;
  market: string;
  interval: string;
  name?: string;
}

export interface Market {
  id: string;
  name?: string;
}

export interface Provider {
  id: string;
  label?: string;
  models: string[];
  defaultModel?: string;
}

export interface Platform {
  id: string;
  label?: string;
}

export interface NodeDefaults {
  provider?: string;
  model?: string;
  platform?: string;
}

export interface Strategy {
  id: string;
  label?: string;
  body: string;
}

export type BybitNetwork = "mainnet" | "testnet";
export type ChainId = "mantle" | "mantle-sepolia";

export interface PlatformCreds {
  apiKey: string;
  apiSecret: string;
}

export interface CliConfig {
  nodeUrl: string;
  provider?: string;
  model?: string;
  /** LLM API keys keyed by provider id. */
  apiKeys?: Record<string, string>;
  /** Trading platform credentials keyed by platform id. */
  platformKeys?: Record<string, PlatformCreds>;
  platform?: string;
  network?: BybitNetwork;
  chain?: ChainId;
}

export const DEFAULT_NETWORK: BybitNetwork = "mainnet";
export const DEFAULT_CHAIN: ChainId = "mantle";

export interface NodeConfig {
  version: string;
  rooms: Room[];
  markets: Market[];
  intervals: string[];
  providers: Provider[];
  platforms: Platform[];
  strategies: Strategy[];
  defaults: NodeDefaults;
}

// export const DEFAULT_NODE_URL = "http://localhost:6161";
export const DEFAULT_NODE_URL = "https://node.hspace.dev";

const FETCH_TIMEOUT_MS = 5000;

let cachedNodeConfig: NodeConfig | null = null;

export function getCachedNodeConfig(): NodeConfig | null {
  return cachedNodeConfig;
}

export function setCachedNodeConfig(config: NodeConfig | null): void {
  cachedNodeConfig = config;
}

function normalizeNodeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseApiKeys(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = pickString(v);
    if (k && key) out[k] = key;
  }
  return out;
}

function parsePlatformKeys(value: unknown): Record<string, PlatformCreds> {
  const out: Record<string, PlatformCreds> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!k || !v || typeof v !== "object") continue;
    const entry = v as Partial<PlatformCreds>;
    const apiKey = pickString(entry.apiKey);
    const apiSecret = pickString(entry.apiSecret);
    if (apiKey && apiSecret) out[k] = { apiKey, apiSecret };
  }
  return out;
}

export async function loadCliConfig(): Promise<CliConfig> {
  const path = getCliConfigPath();
  if (!(await fileExists(path))) {
    return { nodeUrl: DEFAULT_NODE_URL };
  }
  try {
    const raw = await readJson<Partial<CliConfig>>(path);
    const cfg: CliConfig = {
      nodeUrl:
        typeof raw.nodeUrl === "string" && raw.nodeUrl.length > 0
          ? raw.nodeUrl
          : DEFAULT_NODE_URL,
    };
    const provider = pickString(raw.provider);
    if (provider) cfg.provider = provider;
    const model = pickString(raw.model);
    if (model) cfg.model = model;
    const platform = pickString(raw.platform);
    if (platform) cfg.platform = platform;
    if (raw.network === "mainnet" || raw.network === "testnet") {
      cfg.network = raw.network;
    }
    if (raw.chain === "mantle" || raw.chain === "mantle-sepolia") {
      cfg.chain = raw.chain;
    }

    const apiKeys = parseApiKeys(raw.apiKeys);
    // Migrate a legacy single apiKey onto the selected provider.
    const legacyKey = pickString((raw as { apiKey?: unknown }).apiKey);
    if (legacyKey && cfg.provider && apiKeys[cfg.provider] === undefined) {
      apiKeys[cfg.provider] = legacyKey;
    }
    if (Object.keys(apiKeys).length > 0) cfg.apiKeys = apiKeys;

    const platformKeys = parsePlatformKeys(raw.platformKeys);
    if (Object.keys(platformKeys).length > 0) cfg.platformKeys = platformKeys;

    return cfg;
  } catch {
    return { nodeUrl: DEFAULT_NODE_URL };
  }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  await ensureDir(getAgentsRoot());
  await writeJson(getCliConfigPath(), config);
}

export async function updateCliConfig(patch: Partial<CliConfig>): Promise<CliConfig> {
  const current = await loadCliConfig();
  const next: CliConfig = { ...current };

  for (const key of Object.keys(patch) as (keyof CliConfig)[]) {
    const value = patch[key];
    if (value === undefined) {
      delete next[key];
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }

  if (!next.nodeUrl) {
    next.nodeUrl = DEFAULT_NODE_URL;
  }

  await saveCliConfig(next);
  return next;
}

export function getEffectiveNetwork(cfg: CliConfig): BybitNetwork {
  return cfg.network === "testnet" ? "testnet" : "mainnet";
}

export function getEffectiveChain(cfg: CliConfig): ChainId {
  return cfg.chain === "mantle-sepolia" ? "mantle-sepolia" : "mantle";
}

/** Returns an error message when chain and Bybit network are mismatched. */
export function validateChainNetworkPair(
  chain: ChainId,
  network: BybitNetwork,
): string | null {
  if (chain === "mantle" && network !== "mainnet") {
    return 'Chain "mantle" must be paired with Bybit network "mainnet".';
  }
  if (chain === "mantle-sepolia" && network !== "testnet") {
    return 'Chain "mantle-sepolia" must be paired with Bybit network "testnet".';
  }
  return null;
}

export function getProviderApiKey(
  cfg: CliConfig,
  providerId: string | undefined,
): string | undefined {
  if (!providerId) return undefined;
  return cfg.apiKeys?.[providerId];
}

export function getPlatformCreds(
  cfg: CliConfig,
  platformId: string | undefined,
): PlatformCreds | undefined {
  if (!platformId) return undefined;
  return cfg.platformKeys?.[platformId];
}

export async function setNodeUrl(url: string): Promise<CliConfig> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Node URL must use http or https (got "${parsed.protocol}").`);
  }
  return updateCliConfig({ nodeUrl: normalizeNodeUrl(url) });
}

function parseRooms(value: unknown): Room[] {
  if (!Array.isArray(value)) return [];
  const rooms: Room[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<Room>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    const market = typeof e.market === "string" && e.market.length > 0 ? e.market : "";
    const interval = typeof e.interval === "string" && e.interval.length > 0 ? e.interval : "";
    if (!market || !interval) continue;
    const room: Room = { id: e.id, market, interval };
    if (typeof e.name === "string" && e.name.length > 0) room.name = e.name;
    rooms.push(room);
  }
  return rooms;
}

function parseMarkets(value: unknown): Market[] {
  if (!Array.isArray(value)) return [];
  const markets: Market[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<Market>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    const market: Market = { id: e.id };
    if (typeof e.name === "string" && e.name.length > 0) market.name = e.name;
    markets.push(market);
  }
  return markets;
}

function parseIntervals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry);
  }
  return out;
}

function parseProviders(value: unknown): Provider[] {
  if (!Array.isArray(value)) return [];
  const providers: Provider[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Provider).id;
    const models = (entry as Provider).models;
    if (typeof id !== "string" || id.length === 0 || !Array.isArray(models)) continue;
    const cleanModels: string[] = [];
    for (const m of models) {
      if (typeof m === "string" && m.length > 0) cleanModels.push(m);
    }
    if (cleanModels.length === 0) continue;
    const provider: Provider = { id, models: cleanModels };
    const label = (entry as Provider).label;
    if (typeof label === "string" && label.length > 0) provider.label = label;
    const defaultModel = (entry as Provider).defaultModel;
    if (
      typeof defaultModel === "string" &&
      defaultModel.length > 0 &&
      cleanModels.includes(defaultModel)
    ) {
      provider.defaultModel = defaultModel;
    }
    providers.push(provider);
  }
  return providers;
}

function parsePlatforms(value: unknown): Platform[] {
  if (!Array.isArray(value)) return [];
  const platforms: Platform[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Platform).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const platform: Platform = { id };
    const label = (entry as Platform).label;
    if (typeof label === "string" && label.length > 0) platform.label = label;
    platforms.push(platform);
  }
  return platforms;
}

function parseStrategies(value: unknown): Strategy[] {
  if (!Array.isArray(value)) return [];
  const strategies: Strategy[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<Strategy>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    if (typeof e.body !== "string" || e.body.length === 0) continue;
    const strategy: Strategy = { id: e.id, body: e.body };
    if (typeof e.label === "string" && e.label.length > 0) strategy.label = e.label;
    strategies.push(strategy);
  }
  return strategies;
}

function parseDefaults(value: unknown): NodeDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const result: NodeDefaults = {};
  const provider = pickString(obj.provider);
  if (provider) result.provider = provider;
  const model = pickString(obj.model);
  if (model) result.model = model;
  const platform = pickString(obj.platform);
  if (platform) result.platform = platform;
  return result;
}

export async function fetchNodeConfig(url: string): Promise<NodeConfig> {
  const base = normalizeNodeUrl(url);
  const target = `${base}/config`;

  let response: Response;
  try {
    response = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = (err as Error).message || "network error";
    throw new Error(`Could not reach node at ${base} (${reason}).`);
  }

  if (!response.ok) {
    throw new Error(`Node returned HTTP ${response.status} for /config.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Node response at ${target} was not valid JSON.`);
  }

  const cfg = body as Partial<NodeConfig> | null;
  if (
    !cfg ||
    typeof cfg.version !== "string" ||
    !Array.isArray(cfg.rooms)
  ) {
    throw new Error(`Node config at ${target} is malformed.`);
  }

  return {
    version: cfg.version,
    rooms: parseRooms(cfg.rooms),
    markets: parseMarkets(cfg.markets),
    intervals: parseIntervals(cfg.intervals),
    providers: parseProviders(cfg.providers),
    platforms: parsePlatforms(cfg.platforms),
    strategies: parseStrategies(cfg.strategies),
    defaults: parseDefaults(cfg.defaults),
  };
}

export interface EffectiveSelection {
  provider?: string;
  model?: string;
  platform?: string;
}

export function getEffectiveSelection(
  config: CliConfig,
  defaults: NodeDefaults | undefined,
  providers?: Provider[],
): EffectiveSelection {
  const providerId = config.provider ?? defaults?.provider;
  const providerEntry = providerId
    ? providers?.find((p) => p.id === providerId)
    : undefined;

  let model = config.model;
  if (model && providerEntry && !providerEntry.models.includes(model)) {
    model = undefined;
  }
  if (!model) {
    if (providerEntry?.defaultModel && providerEntry.models.includes(providerEntry.defaultModel)) {
      model = providerEntry.defaultModel;
    } else if (providerEntry && defaults?.model && providerEntry.models.includes(defaults.model)) {
      model = defaults.model;
    } else if (providerEntry) {
      model = providerEntry.models[0];
    } else {
      model = defaults?.model;
    }
  }

  return {
    provider: providerId,
    model,
    platform: config.platform ?? defaults?.platform,
  };
}
