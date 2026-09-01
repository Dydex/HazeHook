import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { PageShell } from "@/components/PageShell";
import { SwapWidget } from "@/components/SwapWidget";
import { BalancesPanel } from "@/components/BalancesPanel";

export default function Swap() {
  return (
    <PageShell>
      <Navbar />

      <section className="relative overflow-hidden border-b border-white/[.08]">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-violet-600/20 blur-[120px]" />

        <div className="relative mx-auto flex max-w-4xl flex-col items-center px-6 py-20 text-center">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-violet-300">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
            Live on Ethereum Sepolia
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">Check your swap.</h1>
          <p className="mt-4 max-w-md text-zinc-400">
            Enter an amount to see whether it would clear the fast lane or get routed through commit/settle — read
            live from the deployed HazeHook contract, no wallet connection required to preview.
          </p>

          <div className="mt-10 grid w-full gap-6 text-left sm:grid-cols-[1fr_260px]">
            <SwapWidget />
            <BalancesPanel />
          </div>
        </div>
      </section>

      <Footer />
    </PageShell>
  );
}
