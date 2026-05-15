import LineupPrint from "@/components/LineupPrint";

export default async function PrintPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  return <LineupPrint date={date} />;
}
