export default function AskPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold text-amber-900">Ask the Bee 🐝</h1>
      <p className="text-stone-700">
        Ask anything about the Bumblebeers — e.g. <em>&ldquo;who&rsquo;s getting out to end the inning the most?&rdquo;</em> —
        and Claude will dig through the stats for you.
      </p>
      <div className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-stone-500">
          Phase 5 wires this up to Claude (Sonnet 4.6 by default, Opus 4.7 on demand) with prompt
          caching on the stats payload.
        </p>
      </div>
    </section>
  );
}
