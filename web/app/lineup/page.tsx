import LineupGrid from "@/components/LineupGrid";
import UpcomingGames from "@/components/UpcomingGames";

export default function LineupPage() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-bold text-amber-900">Lineup Notes</h1>
      <p className="text-stone-700">
        Mark each player as <em>can play</em> or <em>should play</em> for every defensive position.
        Shared with the whole team — last save wins. Plan a specific night by tapping into one
        of the games below.
      </p>
      <UpcomingGames />
      <LineupGrid />
    </section>
  );
}
