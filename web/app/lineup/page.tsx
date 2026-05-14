import LineupGrid from "@/components/LineupGrid";
import RosterIntake from "@/components/RosterIntake";

export default function LineupPage() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-bold text-amber-900">Lineup Notes</h1>
      <p className="text-stone-700">
        Mark each player as <em>can play</em> or <em>should play</em> for every defensive position.
        Shared with the whole team — last save wins.
      </p>
      <RosterIntake />
      <LineupGrid />
    </section>
  );
}
