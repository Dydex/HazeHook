import { CONTRACT_LINKS } from "@/lib/contracts";

export function Footer() {
  return (
    <footer className="border-t border-white/[.08] px-6 py-12">
      <div className="mx-auto grid max-w-6xl gap-10 sm:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-5 w-5 rounded-full bg-gradient-to-br from-violet-500 via-pink-500 to-lime-400" />
            <span className="font-mono text-sm font-bold uppercase tracking-widest text-zinc-100">
              haze<span className="text-pink-500">hook</span>
            </span>
          </div>
          <p className="mt-4 max-w-xs text-sm text-zinc-500">
            Routes high-impact Uniswap v4 swaps through a Chainlink VRF-randomized commit/settle flow, with the
            recapture premium paid straight to LPs.
          </p>
        </div>

        <div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Network</div>
          <div className="mt-3 text-sm text-zinc-400">Ethereum Sepolia</div>
          <a
            href="https://docs.uniswap.org/contracts/v4/overview"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block text-sm text-zinc-400 hover:text-zinc-100"
          >
            Uniswap v4 ↗
          </a>
        </div>

        <div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Contracts</div>
          <div className="mt-3 flex flex-col gap-2">
            {CONTRACT_LINKS.map((c) => (
              <a
                key={c.address}
                href={c.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between text-sm text-zinc-400 hover:text-zinc-100"
              >
                <span>{c.label}</span>
                <span className="font-mono text-xs text-zinc-500">
                  {c.address.slice(0, 6)}…{c.address.slice(-4)} ↗
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto mt-10 flex max-w-6xl flex-col gap-2 border-t border-white/[.08] pt-6 font-mono text-[11px] uppercase tracking-widest text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
        <span>© 2026 HazeHook · Testnet only, not financial advice</span>
        <span>Commit / Randomize / Settle</span>
      </div>
    </footer>
  );
}
