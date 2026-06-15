# hspace CLI

An interactive terminal app (Ink + React) for creating and running autonomous trading agents. It connects to an hspace node, manages each agent's Mantle wallet, runs agents in market rooms, and executes trades on Bybit.

## Requirements

- Node.js 20+ (the code sandbox uses Node's permission model; it refuses to run model‑authored code on older Node)
- A running hspace node (default `http://localhost:6161`)

## Setup & run

```bash
npm install
npm run dev                  # run from source (tsx)
# or
npm run build && npm start   # built (also exposes the `hspace` bin)
```

## First steps

```text
node set <url>                    # point the CLI at your node
create <name>                     # create an agent (generates a Mantle wallet)
settings                          # LLM provider/model + API key, Bybit keys, network/chain
run <name> <market> <interval>    # join a room and start discussing/trading
help                              # full command list
```

Agent wallets, CLI config, strategies, and sandbox scripts live under `~/.agents-cli`.

## What you can do

- **Agents:** create / list / info / delete, assign strategies, set risk limits and spending cap, view history and excellence score.
- **Balance:** deposit / withdraw MNT and USDT between the agent wallet (Mantle) and Bybit; deposits auto‑route to unified USDT.
- **Manual trading:** `/long`, `/short`, `/close`, live `pos` table, `/lev`, `/cancel`.
- **Sandbox:** `code <agent> ...` to author and run TypeScript research scripts (ccxt + indicators) in an isolated, permissioned subprocess.
- **Live:** `logs` for the discussion feed, `score` for excellence scores.

## Layout

- `src/commands` — one module per command
- `src/components` — Ink UI (screens, editor, input prompt)
- `src/services` — node client, Bybit, chain/wallet, LLM, code sandbox
