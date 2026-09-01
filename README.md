# HazeHook

A Uniswap v4 hook that defends against sandwich attacks by routing high-price-impact
swaps through a **commit/settle flow**: the swap's execution price bound is drawn
from Chainlink VRF v2.5 at settlement time rather than fixed at commit time, so an
attacker can't precisely size a front-run against it. Low-impact swaps are
untouched and execute instantly through the normal v4 path.

Built for the Uniswap Incubator hookathon (UHI10 — Sustainable Liquidity & MEV
Protection).

---

## How it works

```
User submits swap
       │
       ▼
 ┌─────────────┐   impact ≤ 50bps    ┌───────────────────┐
 │ beforeSwap  │ ───────────────────►│ normal v4 swap     │
 │ (classify)  │                     │ (fast lane, 1 tx)  │
 └─────────────┘                     └───────────────────┘
       │ impact > 50bps
       ▼
 ┌─────────────────────┐
 │ commitSwap()          │  snapshot pool price, lock a
 │ + COMMIT_BOND          │  bond, request VRF randomness
 └─────────────────────┘
       │  (VRF fulfills — usually within a couple minutes)
       ▼
 ┌─────────────────────┐
 │ settleSwap()           │  pick 1 of 5 candidate price
 │                        │  bounds from a ±20bps band,
 │                        │  execute the real v4 swap
 └─────────────────────┘
       │
       ▼
 ┌─────────────────────┐
 │ extra fee premium      │  donate()'d into the pool's
 │ donated to in-range LPs│  own fee-growth accounting
 └─────────────────────┘
```

**What the randomness actually does** (documented honestly, not oversold):
`sqrtPriceLimitX96` is a *bound* the swap can't cross, not a target it's forced to
hit — with fixed liquidity and a fixed `amountSpecified`, the execution price is
close to deterministic regardless. What the randomness varies is which of 5
candidate boundaries (spread across a ±20bps band around the price at commit time)
the swap is allowed to move up to, so an attacker watching the commit transaction
can't know in advance exactly how much room the swap has before it partial-fills or
reverts — which is what a sandwich needs to size precisely.

---

## Contracts

### `src/HazeHook.sol`

| Constant | Value | Meaning |
|---|---|---|
| `RISK_THRESHOLD_BPS` | 50 | Swaps estimated above 0.5% price impact are routed to the protected lane. |
| `PRICE_BAND_BPS` | 20 | The randomized settlement bound is drawn from within ±0.2% of the price at commit time. |
| `NUM_CANDIDATES` | 5 | Number of discrete candidate boundaries the VRF result selects between. |
| `PROTECTED_LANE_FEE_PREMIUM_BPS` | 10 | Extra 0.1% fee charged on protected-lane fills, donated to in-range LPs on top of the pool's normal swap fee. |
| `COMMIT_BOND` | 0.001 ether | Native-currency bond required to call `commitSwap`, refundable via `withdrawBond()` once the swap is settled or cancelled. |

Key entrypoints: `commitSwap` (step 1, payable — see **Known limitations** below),
`settleSwap` (step 2), `cancelExpiredSwap` (reclaim a bond if VRF never resolves
before the deadline), `withdrawBond` (pull-payment bond refund),
`estimatedImpactBps` / `isProtected` / `recommendedSlippageBps` (read-only, used by
the frontend to classify a trade and suggest slippage before submitting it).

### `src/VRFConsumer.sol`

Thin Chainlink VRF v2.5 adapter (`VRFConsumerBaseV2Plus`). Records the fulfilled
random word's `% NUM_CANDIDATES` per swap; settlement itself happens in a separate
transaction the trader (or a relayer) sends once `resultForSwap` reports fulfilled.

---

## Known limitations (documented, not glossed over)

- **The bond and the exact-output fix below are not yet live on the deployed
  Sepolia hook.** The addresses in `frontend/src/lib/contracts.ts` point at an
  earlier deployment of `HazeHook` that predates `COMMIT_BOND` and the
  exact-output classification fix. Redeploying picks a new hook address (mined
  fresh via `HookMiner` to match the permission flags), which means a new pool
  and fresh LP liquidity — deliberately not done as part of this fix without a
  separate go/no-go decision, since it's a costly, hard-to-reverse step.
- **`commitSwap` requires an upfront cost precisely because the impact check
  alone isn't one.** `estimatedImpactBps` is computed from `amountSpecified` as a
  bare number — earlier versions of this contract had no balance or allowance
  check at commit time, so anyone could pass an arbitrarily large
  `amountSpecified` to trivially clear `RISK_THRESHOLD_BPS` for the cost of gas
  alone and force a paid VRF request, repeatable in a loop to drain the
  subscription's LINK. `COMMIT_BOND` closes this: every commit locks real,
  refundable capital, so cost scales with request volume.
- **Exact-output swaps are blocked outright when high-impact, not routed to a
  protected lane.** `commitSwap` only accepts exact-input trades (its own `@dev`
  comment explains why), so a high-impact exact-output swap has no protected path
  through this pool — `_beforeSwap` now classifies both directions and simply
  reverts rather than letting exact-output bypass protection, as an earlier
  version did.
- **Token custody isn't enforced until settlement.** The trader must have
  approved this hook for the input token before calling `commitSwap`;
  `settleSwap` will revert at the transfer step if that allowance is missing or
  insufficient. Not checked up front.
- **`VRFConsumer`'s admin functions (`setHook`, `setCallbackConfig`) sit behind a
  single EOA owner**, set at deploy time. Fine for a testnet demo; a production
  deployment would want a timelock or multisig here.
- **`COMMIT_BOND` is a fixed, testnet-appropriate constant**, not something a
  mainnet deployment would want hardcoded without further tuning against real
  VRF costs and gas prices.
- **Impact estimation is single-tick.** `estimatedImpactBps` ignores tick-crossing
  beyond the current tick's liquidity, which under-estimates real impact for
  trades large enough to cross into a range with different liquidity.

---

## Deployed addresses (Sepolia, chain id 11155111)

| Contract | Address |
|---|---|
| HazeHook | `0x47eba0b231d3cec1d74597ddab60df6a41048080` |
| VRFConsumer | `0x978ac30c2adf302e86b3815a6d165f2893af4ce5` |
| Test token (HTT, open-mint MockERC20) | `0xDE8A1613Ee95a0Ee72fF5B72Af2aAdFe6C783F3D` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| Pool | fee 500, tickSpacing 10, HTT/WETH, 1 WETH ≈ 10,000 HTT |

(See the limitation above — this deployment predates the bond/exact-output fixes.)

---

## Build & test

```shell
$ forge build
$ forge test
$ forge coverage --report summary
```

The frontend lives in `frontend/` (Next.js + RainbowKit + wagmi/viem):

```shell
$ cd frontend
$ npm install
$ npm run dev
```
