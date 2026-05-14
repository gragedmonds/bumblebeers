import NightPlanner from "@/components/NightPlanner";

export default async function NightPage(props: PageProps<"/lineup/[date]">) {
  const { date } = await props.params;
  return (
    <section className="space-y-5">
      <NightPlanner date={date} />
    </section>
  );
}
