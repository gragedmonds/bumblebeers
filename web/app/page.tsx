export default function Home() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold text-amber-900">Trends</h1>
      <p className="text-stone-700">
        Season-by-season BMBL+ scores, leaderboards, and component breakdowns will live here.
      </p>
      <div className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-stone-500">
          Phase 2 will port the Trends Chart.js views from the legacy HTML viewer.
        </p>
      </div>
    </section>
  );
}
