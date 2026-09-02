**A Uniswap v4 hook that makes sandwich attacks harder to size precisely — not by hiding trades, by making their exact execution price unknown until settlement.**

> A sandwich bot needs to know, before it acts, how much slippage room your trade will actually use. Haze doesn't let it find out until after your trade is already queued.

**Not a fixed-slippage guard or a bigger fee** — Haze splits risky swaps into a **commit**, where the trade's intent is locked and a Chainlink VRF request is fired, and a **settle**, where the swap executes bounded by one of five price limits picked at random *after* commit. Small, low-impact trades never touch this — they execute instantly, exactly like a normal v4 swap.

Haze is a single hook (`src/HazeHook.sol`) plus a Chainlink VRF v2.5 adapter (`src/VRFConsumer.sol`). Every high-impact swap is forced through commit/settle; the swap itself is bounded by a `sqrtPriceLimitX96` drawn from 5 candidates after commit, so how much of the trade actually fills isn't knowable in advance. A 0.1% premium on protected fills is routed straight to LPs via `PoolManager.donate()` — the same accounting real swap fees use, no separate claims contract.

**The honest proof point, replayed from a real Sepolia transaction (not a simulation):** a trader committed to sell 200 HTT. The VRF draw picked a tight boundary — only 16 real basis points of price room. The trade filled **36.13 HTT (18%)** before hitting that limit and stopped, exactly as designed; the remaining 163.87 HTT was never touched, and a 0.036 HTT premium (10bps of the *filled* amount) was donated to LPs. That's not a bug — a bound is not a target, and this repo says so in its own code comments rather than only in this README. See [Security & trust assumptions](#security--trust-assumptions) for the rest of what this design does and doesn't guarantee.

| | |
|---|---|
| **Live hook** | [`0xdE8563cd71256d980AB37c7DeD90671915d30080`](https://sepolia.etherscan.io/address/0xdE8563cd71256d980AB37c7DeD90671915d30080) · Sepolia (11155111) |
| **VRF adapter** | [`0x978ac30c2adF302E86b3815A6d165F2893aF4CE5`](https://sepolia.etherscan.io/address/0x978ac30c2adF302E86b3815A6d165F2893aF4CE5) · Chainlink VRF v2.5 |
| **Tests** | 47 passing (Foundry) — `forge test` — 99% lines / 97% branches on the hook, 100% lines / 80% branches on the VRF adapter |
| **Frontend** | `frontend/` — Next.js + RainbowKit + wagmi/viem, real fast-lane execution, commit/settle flow with live VRF status, LP recapture stats, add-liquidity — run locally, no hosted deploy yet |
| **Gas, measured on-chain** | `commitSwap` 384,481 gas · `settleSwap` 227,732 gas (real Sepolia transaction, not an estimate) |

---

## How it works

### 1. Risk classification (`estimatedImpactBps`, `_beforeSwap`)

Every swap through the pool is classified by estimated price impact, computed with the same `SqrtPriceMath` the pool itself swaps with — not a naive amount/liquidity ratio. If a swap (in either exact-input *or* exact-output form — see the fix note below) would move price by more than `RISK_THRESHOLD_BPS` (50 bps), `_beforeSwap` reverts it with `ProtectedSwapRequired`, forcing it through `commitSwap`/`settleSwap` instead. Below that, it's not worth attacking anyway — it executes immediately, no different from a plain v4 swap.

> **Fix applied, not just documented as a gap:** an earlier version only classified exact-input swaps, so the identical trade phrased as exact-output slipped through unprotected entirely. `_beforeSwap` now classifies both; since `commitSwap` is exact-input only, a high-impact exact-output swap simply has no route through this pool at all — it reverts, and the trader has to resubmit as exact-input.

### 2. Commit — bonded, not free (`commitSwap`)

`commitSwap` snapshots the live pool price, requests randomness from the VRF adapter, and records the intent. It also requires a **0.001 ETH bond** (`COMMIT_BOND`) as `msg.value`.

> **Real vulnerability found and closed during development:** `estimatedImpactBps` is computed from `amountSpecified` as a bare number — nothing checks the caller actually holds or approved that amount. Without a cost attached to the call itself, anyone could pass an arbitrarily large `amountSpecified` to trivially clear the risk threshold and force a paid Chainlink VRF request, for free, in a loop, draining the subscription's LINK balance. The bond makes every request cost real, locked capital instead.

### 3. Settle — a bound, not a target (`settleSwap`, `directionalCandidatePrice`)

Once the VRF result lands, `settleSwap` picks one of `NUM_CANDIDATES` (5) prices, evenly spaced across `PRICE_BAND_BPS`, and calls `PoolManager.swap` with that price as `sqrtPriceLimitX96`. Because `directionalCandidatePrice` applies its distance to `sqrtPriceX96` directly rather than to the real price (price = sqrtPrice²), the 5 candidates work out to **real price-bps limits of 12/24/36/48/60** — documented as a found-and-explained inconsistency in the code, not left silent. `PRICE_BAND_BPS` was raised from 20 to 30 specifically so the widest candidate (60 bps) clears `RISK_THRESHOLD_BPS` (50 bps) — before that change, no protected trade could *ever* fully fill in one round, because even the best possible draw fell short of the minimum impact needed to qualify for protection in the first place.

**This does not force the trade to execute at a randomly chosen price** — `sqrtPriceLimitX96` is a boundary the swap cannot cross, not a target it's steered toward. Given fixed liquidity and a fixed requested amount, the execution price itself is close to deterministic; the randomness varies how much room the trade gets before it's cut off, which is what breaks precise sandwich sizing. A future version could derive `amountSpecified` from the chosen candidate price via `SqrtPriceMath` instead, achieving true price-targeting and eliminating partial fills as a side effect — see [Limitations](#limitations--future-work).

### 4. LP recapture (`_recapturePremiumToLPs`)

A `PROTECTED_LANE_FEE_PREMIUM_BPS` (10 bps) premium is charged on the *actually filled* amount — not the originally committed amount, since a partial fill would otherwise overcharge — and routed to in-range LPs via `PoolManager.donate()`. This credits directly into the pool's `feeGrowthGlobal` accounting, the same mechanism ordinary swap fees use, so it pays out proportional to liquidity share with no separate distribution contract to build or trust.

### 5. Bond auto-refund (`_refundBond`, `withdrawBond`)

`settleSwap` and `cancelExpiredSwap` push the bond straight back to the trader (a bounded 30,000-gas transfer) — no separate claim transaction for a normal wallet. If that push fails (a contract wallet with a reverting or gas-hungry `receive()`), the bond is credited to `unclaimedBond` instead of reverting the trade, and `withdrawBond()` recovers it later — a broken refund can never brick the trader's own settlement.

---

## Architecture

```mermaid
sequenceDiagram
    participant Trader
    participant Hook as HazeHook
    participant Consumer as VRFConsumer
    participant Coordinator as Chainlink VRF Coordinator
    participant PM as PoolManager

    Trader->>Hook: commitSwap(key, zeroForOne, amount, deadline) + 0.001 ETH bond
    Hook->>PM: getSlot0 (snapshot price)
    Hook->>Consumer: requestRandomness(swapId)
    Consumer->>Coordinator: requestRandomWords
    Note over Trader,PM: a few blocks later
    Coordinator-->>Consumer: fulfillRandomWords(candidateIndex)
    Trader->>Hook: settleSwap(swapId)
    Hook->>Consumer: resultForSwap(swapId)
    Hook->>Hook: directionalCandidatePrice -> sqrtPriceLimitX96
    Hook->>PM: unlock() -> unlockCallback
    PM->>PM: swap bounded by sqrtPriceLimitX96 (partial fill possible)
    Hook->>PM: donate() premium on actual fill -> LPs
    Hook-->>Trader: settle/take deltas + bond refund
```

| Contract | Role |
|---|---|
| `HazeHook` | The hook itself — risk classification, commit/settle state machine, bond escrow, LP recapture |
| `VRFConsumer` | Chainlink VRF v2.5 adapter — gated so only the hook can request randomness (`NotHook`), owner-configurable callback gas/confirmations |
| Sepolia `PoolManager` | Canonical v4 core — all actual swap/donate logic runs through its `unlock` callback |
| HTT (MockERC20) | Free-mint test token — deliberately open `mint()`, since WETH is the real capital constraint on testnet |
| Sepolia WETH | Real Sepolia WETH — the pool's other leg |

---

## Live deployment

| Contract | Address |
|---|---|
| **HazeHook** | [`0xdE8563cd71256d980AB37c7DeD90671915d30080`](https://sepolia.etherscan.io/address/0xdE8563cd71256d980AB37c7DeD90671915d30080) |
| **VRFConsumer** | [`0x978ac30c2adF302E86b3815A6d165F2893aF4CE5`](https://sepolia.etherscan.io/address/0x978ac30c2adF302E86b3815A6d165F2893aF4CE5) |
| Pool | HTT/WETH, fee 500 (0.05%), tick spacing 10, 1 WETH ≈ 10,000 HTT starting price |
| Test token (HTT) | [`0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D`](https://sepolia.etherscan.io/address/0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D) |
| Sepolia WETH | [`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`](https://sepolia.etherscan.io/address/0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14) |
| PoolManager | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) |
| PositionManager | [`0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`](https://sepolia.etherscan.io/address/0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4) |
| V4 Quoter | [`0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227`](https://sepolia.etherscan.io/address/0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227) |
| V4 Router | [`0xf13D190e9117920c703d79B5F33732e10049b115`](https://sepolia.etherscan.io/address/0xf13D190e9117920c703d79B5F33732e10049b115) |
| Chainlink VRF Coordinator | [`0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B`](https://sepolia.etherscan.io/address/0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B) |

This is the **third** hook deployment of this project. A pool's identity includes its hook address, so each contract-level fix (the commit-bond fix, then the auto-refund + wider price band) required a fresh pool alongside it — the two retired hooks and their pools are left untouched on-chain, not migrated, and the LP capital from each was reclaimed (`script/WithdrawStrandedPools.s.sol`) and reused to seed the next one rather than needing fresh testnet funds each time.

---

## Build, test & deploy

### Quickstart

```bash
cd haze-hook
forge install       # forge-std, v4-template, chainlink-brownie-contracts
forge build          # solc 0.8.26
forge test           # 47 tests, 3 suites — all pass
forge coverage --report summary
```

Foundry's newer lint pass can't resolve a bare `test/utils/Deployers.sol` import inside v4-template's own `BaseScript.sol` (the real compiler resolves it fine relative to v4-template's package root) — `[lint] lint_on_build = false` in `foundry.toml` works around it, matching v4-template's own config.

### Deploy runbook

All scripts live in `script/`, use `HookMiner` to mine a CREATE2 address matching the hook's permission flags (`beforeSwap` only), and broadcast via a named Foundry keystore account rather than a raw private key.

| Script | What it does |
|---|---|
| `DeployHook.s.sol` | Deploys a fresh `VRFConsumer` + `HazeHook` pair, wires `consumer.setHook(hook)` |
| `RedeployHook.s.sol` | Deploys a new `HazeHook` only, reusing an already-funded `VRFConsumer` (repoints it via `setHook` — avoids re-registering a new consumer with the VRF subscription) |
| `DeployLopsidedPool.s.sol` | Initializes the HTT/WETH pool at a deliberately lopsided 1:10,000 starting price and seeds liquidity |
| `RedeployPool.s.sol` | Same pool config, pointed at whatever hook `RedeployHook.s.sol` most recently deployed |
| `WithdrawStrandedPools.s.sol` | Burns LP position NFTs left behind by a hook redeploy and sweeps the underlying tokens back to the deployer for reuse |

```bash
forge script script/RedeployHook.s.sol \
  --rpc-url <sepolia_rpc> --account <keystore_name> --broadcast

forge script script/RedeployPool.s.sol \
  --rpc-url <sepolia_rpc> --account <keystore_name> --broadcast
```

### Frontend

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
```

Next.js (Pages Router) + RainbowKit + wagmi/viem. Reads pool price/liquidity via direct `extsload` storage reads on `PoolManager` (no separate StateView deployment needed); the fast lane executes real swaps through Sepolia's canonical V4 Router; the protected lane drives the full commit → wait-on-VRF → settle flow with a live countdown and cancel-if-expired path. `/pool` shows LP recapture stats (scanned from `PremiumRecaptured` events) and an add-liquidity form.

---

## Security & trust assumptions

Hackathon-scope code — **not audited, testnet only, do not deploy with real funds without a proper review.**

- **This does not fully solve sandwich attacks — it narrows the window.** `commitSwap` reveals nothing executable yet. But the base price at commit time is public, and the candidate-price formula is public code, so an attacker can compute all 5 possible boundaries immediately — they just don't know which wins, so they're reduced to an expected-value play across a known 5-way distribution rather than a certain one. More importantly: once `settleSwap` is broadcast, the *exact* boundary is sitting in public calldata before it's mined — the actual value-moving swap is, at that moment, just as sandwichable as any ordinary bounded swap. **The real fix for that specific gap is submitting `settleSwap` through a private relay** (e.g. Flashbots Protect) in production; this isn't demonstrable on Sepolia since there's no real economic incentive for an adversary to attack testnet transactions in the first place.
- **Reentrancy.** `settleSwap` sets `pending.settled = true` *before* the external `poolManager.unlock()` call (checks-effects-interactions) — an earlier version set it after, leaving a window where a malicious token's transfer hooks could re-enter and double-settle. `unlockCallback` is gated `onlyPoolManager`.
- **VRF request spam.** Closed via the commit bond (see [above](#2-commit--bonded-not-free-commitswap)) — commitSwap previously had no economic cost, only a risk-threshold check that any caller could clear for free with a fabricated `amountSpecified`.
- **Admin key.** `VRFConsumer.setHook`/`setCallbackConfig` sit behind a single EOA owner (`Ownable`, from `VRFConsumerBaseV2Plus`) — fine for a testnet demo, a real production deployment needs a timelock or multisig here.
- **Token custody gap, documented not hidden.** `commitSwap` doesn't check the trader's balance/allowance up front — `settleSwap` simply reverts at the transfer step if it's missing. A trader needs to have approved the hook for the input token before committing.
- **Impact estimation is deliberately conservative.** `estimatedImpactBps` ignores tick-crossing beyond the current tick's liquidity, which under-estimates real impact for large trades — meaning the classifier's error, when it errs, routes a trade to the protected lane a full simulation would've called safe, not the reverse.

## Limitations & future work

- **Partial fills are expected, not a bug — and they're a real UX cost.** Because `sqrtPriceLimitX96` bounds the trade rather than targeting a price, and the price band is deliberately narrower than the risk threshold that triggers protection, a large protected-lane trade routinely needs 2-3 commit/settle rounds to fill meaningfully. The honest fix is true price-targeting (derive `amountSpecified` from the chosen candidate price via `SqrtPriceMath`, executing fully at that price instead of up to a boundary) — a documented next step, not yet built, because it doesn't solve "fill my whole large request" either (the candidate band is still narrow relative to a genuinely large trade) — it trades discovering the fill amount by hitting a wall for computing it up front.
- **`settleSwap` mempool visibility** — see [Security](#security--trust-assumptions) above; needs a private relay in production.
- **Single admin key on `VRFConsumer`** — needs a multisig/timelock for anything beyond a demo.
- **Threshold/band tuning is a live parameter, not a solved one.** `RISK_THRESHOLD_BPS`/`PRICE_BAND_BPS` trade off fill completeness against worst-case settle-time price concession; current values (50/30) were chosen so a threshold-sized trade can fully fill on a lucky draw without making the randomization a formality.
- **Compared to batch-auction systems** (CoW Protocol) or time-spread execution (TWAMM), this trades a stronger protection guarantee for a simpler, fully on-chain, single-contract mechanism — worth stating plainly rather than implying equivalence.

---

## Repo layout

```
src/
  HazeHook.sol           # the hook: risk classification, commit/settle, bond escrow, LP recapture
  VRFConsumer.sol        # Chainlink VRF v2.5 adapter
script/
  DeployHook.s.sol / RedeployHook.s.sol       # hook (+ consumer) deployment
  DeployLopsidedPool.s.sol / RedeployPool.s.sol  # pool init + liquidity seeding
  WithdrawStrandedPools.s.sol                 # reclaim liquidity from a retired pool
  AddLiquidity.s.sol / DeployPool.s.sol       # earlier iterations, kept for history
test/
  HazeHook.t.sol             # unit tests against a mocked PoolManager
  HazeHookIntegration.t.sol  # integration tests against a real v4 PoolManager
  VRFConsumer.t.sol          # unit tests against VRFCoordinatorV2_5Mock
frontend/
  src/pages/     # /, /swap, /pool, /about
  src/components/  # SwapWidget, BalancesPanel, AddLiquidityForm, RecaptureStats
  src/lib/       # contracts.ts — addresses, ABIs, on-chain math helpers
hook-architecture.md   # the original design doc this was built from
```

---

## License

MIT — see [`LICENSE`](LICENSE). Built on the [Uniswap v4 Hook Template](https://github.com/Uniswap/v4-template) (also MIT).
