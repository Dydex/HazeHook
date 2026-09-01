import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { PageShell } from "@/components/PageShell";
import { RecaptureStats } from "@/components/RecaptureStats";
import { AddLiquidityForm } from "@/components/AddLiquidityForm";

export default function Pool() {
  return (
    <PageShell>
      <Navbar />

      <section className="relative overflow-hidden border-b border-white/[.08]">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-lime-600/10 blur-[120px]" />

        <div className="relative mx-auto flex max-w-4xl flex-col items-center px-6 py-20 text-center">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-lime-400/40 bg-lime-400/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-lime-300">
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
            For liquidity providers
          </span>
          <h1 className="text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">The pool.</h1>
          <p className="mt-4 max-w-md text-zinc-400">
            What protected-lane swaps have paid LPs so far, and a way to add more liquidity.
          </p>

          <div className="mt-10 grid w-full gap-6 text-left sm:grid-cols-2">
            <RecaptureStats />
            <AddLiquidityForm />
          </div>
        </div>
      </section>

      <Footer />
    </PageShell>
  );
}
