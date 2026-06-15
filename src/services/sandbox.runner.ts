import { ENVELOPE_MARKER } from "./sandbox.constants.js";

/**
 * Source of the sandbox runner harness. It is written verbatim to
 * `<sandboxRoot>/.runner.mjs` and executed as the entrypoint of every locked
 * child process. Keeping it as an embedded string (rather than a shipped .mjs)
 * means it survives the CLI's `tsc`-only build with no extra copy step, and it
 * always resolves `ccxt` / `technicalindicators` from the shared sandbox
 * node_modules because it lives at the sandbox root.
 *
 * The harness intentionally uses no backtick template literals so it can be
 * embedded safely; the only interpolation below is the envelope marker.
 */
export const RUNNER_SOURCE = `import { pathToFileURL } from 'node:url';

const MARKER = ${JSON.stringify(ENVELOPE_MARKER)};
const started = Date.now();
const logs = [];
const errs = [];
const origLog = console.log;

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

console.log = (...a) => { logs.push(a.map(fmt).join(' ')); };
console.info = console.log;
console.error = (...a) => { errs.push(a.map(fmt).join(' ')); };
console.warn = console.error;

function replacer(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function') return undefined;
  return v;
}

function emit(env) {
  console.log = origLog;
  let safe;
  try { safe = JSON.stringify(env, replacer); }
  catch (e) { safe = JSON.stringify({ ok: false, error: 'result not serializable: ' + String(e), stdout: '', stderr: '', durationMs: Date.now() - started }); }
  process.stdout.write('\\n' + MARKER + safe + '\\n');
}

async function loadModule(name) {
  try { return await import(name); } catch { return null; }
}

function symbolFor(m) {
  if (!m) return '';
  if (m.includes('/')) return m;
  if (m.endsWith('USDT')) return m.slice(0, -4) + '/USDT:USDT';
  return m;
}

let capturedSignal = null;
function normalizeBias(v) {
  const up = String(v == null ? '' : v).trim().toUpperCase();
  return (up === 'LONG' || up === 'SHORT') ? up : 'NOTR';
}
function normalizeConfidence(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function recordSignal(sig) {
  if (sig == null || typeof sig !== 'object') return sig;
  capturedSignal = {
    bias: normalizeBias(sig.bias),
    confidence: normalizeConfidence(sig.confidence),
    notes: typeof sig.notes === 'string' ? sig.notes : undefined,
    data: sig.data,
  };
  return capturedSignal;
}

async function main() {
  const runPath = process.argv[2];
  let opts = {};
  try { opts = JSON.parse(process.argv[3] || '{}'); } catch {}

  const ccxtMod = await loadModule('ccxt');
  const taMod = await loadModule('technicalindicators');
  const ccxt = ccxtMod ? (ccxtMod.default || ccxtMod) : null;
  const ta = taMod ? (taMod.default || taMod) : null;

  const network = opts.network === 'testnet' ? 'testnet' : 'mainnet';
  let exchange = null;
  if (ccxt && ccxt.bybit) {
    exchange = new ccxt.bybit({ enableRateLimit: true, options: { defaultType: 'swap' } });
    if (network === 'testnet' && typeof exchange.setSandboxMode === 'function') {
      exchange.setSandboxMode(true);
    }
  }

  const market = opts.market || '';
  const ctx = {
    params: opts.params || {},
    market,
    symbol: opts.symbol || symbolFor(market),
    interval: opts.interval || '',
    network,
    ccxt,
    ta,
    exchange,
    symbolFor,
    log: (...a) => { logs.push(a.map(fmt).join(' ')); },
    async fetchOHLCV(symbol, timeframe, limit) {
      if (!exchange) throw new Error('ccxt is not installed in this sandbox');
      return exchange.fetchOHLCV(symbol || ctx.symbol, timeframe || '1h', undefined, limit || 200);
    },
    async fetchClosedOHLCV(symbol, timeframe, limit) {
      const rows = await ctx.fetchOHLCV(symbol, timeframe, limit);
      return rows && rows.length ? rows.slice(0, -1) : rows;
    },
    async fetchTicker(symbol) {
      if (!exchange) throw new Error('ccxt is not installed in this sandbox');
      return exchange.fetchTicker(symbol || ctx.symbol);
    },
    closedOHLCV(ohlcv) { const a = ohlcv || []; return a.length ? a.slice(0, -1) : a; },
    lastClosed(ohlcv) { const a = ohlcv || []; return a.length >= 2 ? a[a.length - 2] : (a[a.length - 1] || null); },
    closes(ohlcv) { return (ohlcv || []).map((c) => c[4]); },
    highs(ohlcv) { return (ohlcv || []).map((c) => c[2]); },
    lows(ohlcv) { return (ohlcv || []).map((c) => c[3]); },
    volumes(ohlcv) { return (ohlcv || []).map((c) => c[5]); },
    setSignal(sig) { return recordSignal(sig); },
    signal(sig) { return recordSignal(sig); },
  };

  // Also expose bare globals so scripts that call set_signal(...) / setSignal(...)
  // directly (a common model habit) work instead of throwing ReferenceError.
  globalThis.set_signal = recordSignal;
  globalThis.setSignal = recordSignal;
  globalThis.ctx = ctx;

  let mod;
  try {
    mod = await import(pathToFileURL(runPath).href);
  } catch (e) {
    return emit({ ok: false, error: 'import failed: ' + ((e && e.message) || String(e)), stdout: logs.join('\\n'), stderr: errs.join('\\n'), durationMs: Date.now() - started });
  }

  let fn = null;
  if (typeof mod.default === 'function') fn = mod.default;
  else if (typeof mod.run === 'function') fn = mod.run;

  try {
    let result;
    if (fn) result = await fn(ctx);
    else if (mod.default !== undefined) result = mod.default;
    // If the script returned a signal-shaped object and didn't emit one explicitly, use it.
    if (!capturedSignal && result && typeof result === 'object' && 'bias' in result) {
      recordSignal(result);
    }
    if (exchange && typeof exchange.close === 'function') { try { await exchange.close(); } catch {} }
    emit({ ok: true, result, signal: capturedSignal, stdout: logs.join('\\n'), stderr: errs.join('\\n'), durationMs: Date.now() - started });
  } catch (e) {
    if (exchange && typeof exchange.close === 'function') { try { await exchange.close(); } catch {} }
    emit({ ok: false, error: (e && e.stack) || (e && e.message) || String(e), signal: capturedSignal, stdout: logs.join('\\n'), stderr: errs.join('\\n'), durationMs: Date.now() - started });
  }
}

main().catch((e) => {
  process.stdout.write('\\n' + MARKER + JSON.stringify({ ok: false, error: String((e && e.message) || e), stdout: '', stderr: '', durationMs: 0 }) + '\\n');
});
`;
