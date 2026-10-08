# Coin Trader · Blob Desk

A Solana memecoin trading desk run by eight pixel-blob agents. Each new token walks a kill chain
(`free_kill → trade_kill → chain_kill → soft_kill → pick`). Chief picks one survivor, and the bot buys it through Jupiter.
The dashboard is an installable PWA with an animated isometric office, live charts and a hold-to-confirm kill switch.

> **Status: Phase 1 (shell and visuals).** Everything on screen is driven by a mock desk: fake tokens, fake fills, no network.
> `TRADING_MODE` defaults to `shadow`. No code path that signs or sends a transaction exists yet.

## Layout

```
apps/bot        Node 22 + Fastify API (phase 1: serves the mock /state)
apps/web        Vite + React dashboard, PWA, canvas office, lightweight-charts
packages/shared StateSnapshot types, thresholds.ts, the kill-chain evaluator, mock desk
scripts/        icon generator, pre-commit secret scan
```

## Local dev

Requires Node 22 and pnpm 10 (`corepack enable`).

```sh
pnpm install          # also points git hooks at .githooks (secret scan on commit)
pnpm dev              # bot API on :8787 + web on :5173. The web app runs its own in-browser mock desk.
pnpm --filter @coin/web dev:bot   # web reads /state from the local bot instead (run the bot too)
pnpm test             # unit tests: kill-chain order, mock desk, API, config, log redaction
pnpm typecheck
pnpm build:web        # → apps/web/dist
pnpm secret-scan      # scan every tracked file
```

To open it on your phone during dev, Vite listens on your LAN (`http://<your-ip>:5173`). The service worker only registers
in production builds, so to test installing on the home screen run `pnpm --filter @coin/web build && pnpm --filter @coin/web preview`
or use the Pages deploy.

### Where the data comes from

| `VITE_STATE_URL` | Source |
| --- | --- |
| unset | In-browser `MockDesk` (`packages/shared/src/mock`). A "Demo data" banner shows. |
| `https://…/state` | The bot, polled every 2 s while the tab is visible and every 30 s in the background |

## Deploy the web app to Cloudflare Pages

Pick one of the two options below.

**A. Cloudflare's Git integration (no secrets in GitHub).** In Cloudflare: Workers & Pages → Create → Pages → Connect to Git → this repo.
- Build command: `pnpm install --frozen-lockfile && pnpm build:web`
- Build output directory: `apps/web/dist`
- Environment variable: `NODE_VERSION=22` (optionally `VITE_STATE_URL` later)

**B. GitHub Action (`.github/workflows/pages.yml`).** Create a Pages project named `coin-trader`. Then add the repo secrets
`CLOUDFLARE_API_TOKEN` (needs Pages: Edit permission) and `CLOUDFLARE_ACCOUNT_ID`, and set the repo variable `PAGES_ENABLED=true`.
Every push to `main` then deploys.

Then put the Pages site behind **Cloudflare Access** (Zero Trust → Access → Applications → self-hosted, policy: your email only).
The full server and tunnel guide arrives as `DEPLOY.md` in phase 4.

## Phase 1 test checklist

On the phone (375–430 px wide):
- [ ] Sticky top bar shows the SHADOW badge, balance, today's PnL and the AI budget gauge
- [ ] Agent cards sit in 2 columns; tapping a card expands it
- [ ] The office canvas is crisp (no blur) and fills the width; blobs carry coins desk to desk and show bubbles; the caption under it repeats the latest line
- [ ] Tapping a blob shows its last quote
- [ ] Charts pan with a horizontal swipe; vertical swipes still scroll the page
- [ ] Analysis / Thresholds are tabs; "Why it died" chips show the step that killed each token
- [ ] The kill switch in the bottom bar does nothing on a quick tap and engages after a 2 s hold (board says BUYS OFF, position sells). A second 2 s hold releases it.
- [ ] No sideways scrolling anywhere
- [ ] Install: Android Chrome shows "Install app" (or menu → Install). iPhone Safari: Share → Add to Home Screen. Opens standalone, and the top bar clears the notch.
- [ ] ⚙ → Alerts: enable notifications, then "Send test" (on iPhone this needs the home-screen app)

On desktop: five bands (header, 4×2 cards, office, balance, analysis + thresholds side by side), and the hold-to-confirm kill switch in the header.

## Safety rules (enforced as the phases land)

- `TRADING_MODE=shadow` by default. `live` must be set explicitly and logs a loud warning at startup.
- The wallet key lives only in an encrypted file or env var on the server. It never goes in the repo, frontend, logs, SQLite or `/state`. A test checks the snapshot for key-shaped strings.
- Only Jupiter swap transactions can be signed. No transfer code path exists.
- Write endpoints verify the Cloudflare Access JWT server-side.
- `.env` is gitignored; `.env.example` is committed. The pre-commit hook blocks key-shaped strings (it uses gitleaks too if installed).

## Credits

Charts by [TradingView Lightweight Charts™](https://www.tradingview.com/). All pixel art, the logo and the in-canvas 3×5 bitmap font are original to this project.
UI font: Silkscreen (SIL Open Font License).
