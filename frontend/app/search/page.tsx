import DiscoveryPageClient from "@/components/DiscoveryPageClient";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  return (
    <DiscoveryPageClient
      title="SEARCH"
      subtitle="Find markets by question, tag, or category"
      initialQuery={q ?? ""}
    />
  );
}
