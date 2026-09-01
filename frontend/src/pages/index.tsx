import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { PageShell } from "@/components/PageShell";
import { HOOK_PARAMS } from "@/lib/contracts";

const TICKER_FACTS = [
  "RISK THRESHOLD = 0.50%",
  "PRICE BAND = ±0.20%",
  "5 CANDIDATE PRICES",
  "CHAINLINK VRF v2.5",
  "LP PREMIUM = 0.10%",
  "NO KEEPER · NO ORACLE",
  "SETTLEMENT IS RANDOM, NOT INSTANT",
];

const STATS = [
  { value: `${HOOK_PARAMS.riskThresholdBps / 100}%`, label: "Risk threshold", color: "text-violet-400" },
  { value: `±${HOOK_PARAMS.priceBandBps / 100}%`, label: "Settlement price band", color: "text-pink-400" },
  { value: `${HOOK_PARAMS.numCandidates}`, label: "Candidate prices", color: "text-cyan-400" },
  { value: `${HOOK_PARAMS.premiumBps / 100}%`, label: "LP recapture premium", color: "text-lime-400" },
];

const MOVES = [
  {
    n: "01",
    color: "text-violet-400",
    border: "border-violet-500/30",
    title: "Commit",
    body: "A high-impact swap locks its intent on-chain and requests randomness from Chainlink VRF. Nothing executes yet — there's nothing for a bot to price in advance.",
  },
  {
    n: "02",
    color: "text-pink-400",
    border: "border-pink-500/30",
    title: "Randomize",
    body: "Chainlink's VRF node returns a number nobody — not even the trader or the hook — could predict at commit time. It selects 1 of 5 pre-committed price boundaries.",
  },
  {
    n: "03",
    color: "text-cyan-400",
    border: "border-cyan-400/30",
    title: "Settle",
    body: "The swap executes bounded by the randomly-selected price limit. The exact boundary was unknowable until after the trade was already locked in.",
  },
  {
    n: "04",
    color: "text-lime-400",
    border: "border-lime-400/30",
    title: "Recapture",
    body: "A small premium on the settled amount is donated straight into the pool's fee-growth accounting — paid to LPs, proportional to their share, not to the hook.",
  },
];

export default function Home() {
  return (
    <PageShell>
      <Navbar />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/[.08]">
        <div className="pointer-events-none absolute -top-40 left-1/4 h-[480px] w-[480px] rounded-full bg-violet-600/20 blur-[120px]" />
        <div className="pointer-events-none absolute -bottom-40 right-1/4 h-[480px] w-[480px] rounded-full bg-pink-600/20 blur-[120px]" />

        <div className="relative mx-auto max-w-3xl px-6 py-28 text-center">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-violet-300">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
            Live on Ethereum Sepolia
          </span>

          <h1 className="text-5xl font-bold leading-[1.05] tracking-tight text-zinc-50 sm:text-6xl">
            Sandwich bots.
            <br />
            <span className="text-pink-500 underline decoration-4 underline-offset-8">Lose the trade.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-zinc-400">
            High-impact swaps settle at a price only Chainlink VRF decides — after the trade is already locked in.
            Small swaps never notice a thing.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/swap"
              className="flex h-12 items-center justify-center rounded-full bg-zinc-100 px-6 font-mono text-xs font-bold uppercase tracking-widest text-black transition-colors hover:bg-white"
            >
              Check my swap
            </Link>
            <Link
              href="/about"
              className="flex h-12 items-center justify-center rounded-full bg-pink-600 px-6 font-mono text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-pink-500"
            >
              How it works
            </Link>
          </div>
        </div>
      </section>

      {/* Ticker */}
      <div className="overflow-hidden border-b border-white/[.08] bg-white/[.02] py-3">
        <div className="flex w-max animate-marquee gap-8 font-mono text-xs uppercase tracking-widest text-zinc-500">
          {[...TICKER_FACTS, ...TICKER_FACTS].map((fact, i) => (
            <span key={i} className="flex items-center gap-8">
              {fact}
              <span className="text-violet-500">◆</span>
            </span>
          ))}
        </div>
      </div>

      {/* Stats */}
      <section className="border-b border-white/[.08]">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-white/[.08] sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="bg-[#08080b] px-6 py-8">
              <div className={`font-mono text-3xl font-bold ${s.color}`}>{s.value}</div>
              <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-zinc-500">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* The Primitive */}
      <section className="border-b border-white/[.08] px-6 py-24">
        <div className="mx-auto max-w-4xl text-center">
          <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">The primitive</span>
          <h2 className="mt-4 text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">One swap, two lanes.</h2>
          <p className="mx-auto mt-4 max-w-xl text-zinc-400">
            Every swap is classified before it ever executes. Small ones move on immediately. Large ones — the ones
            actually worth sandwiching — get routed somewhere a bot can&apos;t price in advance.
          </p>
        </div>

        <div className="mx-auto mt-14 grid max-w-4xl gap-6 sm:grid-cols-2">
          <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/[.04] p-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan-300">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              Fast lane
            </span>
            <h3 className="mt-4 text-xl font-bold text-zinc-50">Executes instantly</h3>
            <ul className="mt-4 space-y-2 text-sm text-zinc-400">
              <li>→ Under {HOOK_PARAMS.riskThresholdBps / 100}% price impact</li>
              <li>→ Standard v4 swap, no delay</li>
              <li>→ Routable through any interface</li>
            </ul>
          </div>

          <div className="rounded-2xl border border-pink-500/30 bg-pink-500/[.04] p-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-pink-500/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-pink-300">
              <span className="h-1.5 w-1.5 rounded-full bg-pink-400" />
              Protected lane
            </span>
            <h3 className="mt-4 text-xl font-bold text-zinc-50">Commit, then settle</h3>
            <ul className="mt-4 space-y-2 text-sm text-zinc-400">
              <li>→ Over {HOOK_PARAMS.riskThresholdBps / 100}% price impact</li>
              <li>→ Price boundary picked by Chainlink VRF</li>
              <li>→ Settles in a follow-up transaction</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Four moves */}
      <section className="border-b border-white/[.08] px-6 py-24">
        <div className="mx-auto max-w-6xl">
          <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">How it flows</span>
          <h2 className="mt-4 text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">Four moves.</h2>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {MOVES.map((m) => (
              <div key={m.n} className={`rounded-2xl border ${m.border} bg-white/[.02] p-6`}>
                <div className={`font-mono text-3xl font-bold ${m.color}`}>{m.n}</div>
                <h3 className="mt-3 text-lg font-bold text-zinc-50">{m.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-6 py-24">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-pink-500/30 bg-white/[.02] px-8 py-16 text-center">
          <div className="pointer-events-none absolute -bottom-32 left-1/2 h-64 w-[80%] -translate-x-1/2 rounded-full bg-pink-600/30 blur-[100px]" />
          <h2 className="relative text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">
            Stop paying the sandwich tax.
          </h2>
          <p className="relative mx-auto mt-4 max-w-md text-zinc-400">
            Check whether your next swap would be protected — free, on Sepolia, no commitment.
          </p>
          <Link
            href="/swap"
            className="relative mt-8 inline-flex h-12 items-center justify-center rounded-full bg-zinc-100 px-8 font-mono text-xs font-bold uppercase tracking-widest text-black transition-colors hover:bg-white"
          >
            Check my swap
          </Link>
        </div>
      </section>

      <Footer />
    </PageShell>
  );
}
