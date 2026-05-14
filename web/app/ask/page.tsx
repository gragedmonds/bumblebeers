import AskTheBee from "@/components/AskTheBee";

export default function AskPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold text-amber-900">Ask the Bee 🐝</h1>
      <p className="text-stone-700">
        Ask anything about the Bumblebeers — career BMBL+, MVP nights, season trends, who&apos;s
        hot, who&apos;s clutch. Backed by Claude with the stats baked in.
      </p>
      <AskTheBee />
    </section>
  );
}
