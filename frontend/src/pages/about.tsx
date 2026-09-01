import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { PageShell } from "@/components/PageShell";
import { HOOK_PARAMS } from "@/lib/contracts";

const FAQ = [
  {
    q: "Why do small swaps skip all of this?",
    a: "Sandwich attacks only make sense when there's enough price movement to profit from. A hook that protects every trade equally would just slow everyone down for no reason — so only swaps that cross the risk threshold get routed through commit/settle.",
  },
  {
    q: "Is this actually random, or just obfuscated?",
    a: "It's real Chainlink VRF v2.5 — a verifiable randomness oracle, not a pseudo-random on-chain trick like block.prevrandao. The value doesn't exist anywhere until after your swap is already committed.",
  },
  {
    q: "Does this mean my swap always executes at a worse price?",
    a: "No — the randomness picks a boundary, not a price. Your swap still executes against the real pool; the boundary just moves within a tight ±0.20% band so an attacker can't calculate the exact setup in advance.",
  },
  {
    q: "Who pays for this protection?",
    a: "A small premium (0.10% of the settled amount) is added on protected-lane swaps and routed directly to liquidity providers — not the protocol.",
  },
];

export default function About() {
  return (
    <PageShell>
      <Navbar />

      <section className="border-b border-white/[.08] px-6 py-24">
        <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-violet-300">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              The unfair advantage
            </span>
            <h1 className="mt-6 text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">
              Bots can&apos;t plan for a price that doesn&apos;t exist yet.
            </h1>
            <p className="mt-6 leading-relaxed text-zinc-400">
              A sandwich attack needs to know almost exactly where your trade will land, so it can front-run and
              back-run it for profit. Protected-lane swaps break that assumption: the settlement boundary is chosen
              by Chainlink VRF <em>after</em> the swap is committed, not before.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-zinc-300">
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                No off-chain keeper, no oracle to trust
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                Real VRF, not a same-block pseudo-random trick
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                LPs get paid extra, not the hook
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-white/[.08] bg-black/40 p-6 font-mono text-xs leading-relaxed text-zinc-400">
            <div className="mb-4 text-zinc-500">HazeHook · Sepolia</div>
            <pre className="whitespace-pre-wrap">
{`beforeSwap → impact > ${HOOK_PARAMS.riskThresholdBps / 100}%?
  └─ yes → revert, must commitSwap()

commitSwap → requestRandomness()
  └─ VRF fulfills off-chain

settleSwap → candidate = VRF % ${HOOK_PARAMS.numCandidates}
  └─ swap bounded by candidate price
  └─ ${HOOK_PARAMS.premiumBps / 100}% premium donated to LPs`}
            </pre>
          </div>
        </div>
      </section>

      <section className="px-6 py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-4xl font-bold tracking-tight text-zinc-50">Good questions.</h2>
          <div className="mt-10 flex flex-col gap-3">
            {FAQ.map((item) => (
              <details key={item.q} className="group rounded-xl border border-white/[.08] bg-white/[.02] p-5">
                <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-zinc-100">
                  {item.q}
                  <span className="text-zinc-500 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-zinc-400">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </PageShell>
  );
}
