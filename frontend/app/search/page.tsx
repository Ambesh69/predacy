import DiscoveryPageClient from "@/components/DiscoveryPageClient";
import type { DiscoverySort } from "@/lib/discovery";

function toSort(value: string | undefined): DiscoverySort {
  if (value === "volume_asc") return value;
  if (value === "ending_soon") return value;
  if (value === "newest") return value;
  return "volume_desc";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; tag?: string; category?: string }>;
}) {
  const { q, sort, tag, category } = await searchParams;

  return (
    <DiscoveryPageClient
      title="SEARCH"
      subtitle="Find markets by question, tag, or category"
      initialQuery={q ?? ""}
      initialSort={toSort(sort)}
      initialTag={tag ?? "all"}
      initialCategory={category ?? "all"}
    />
  );
}
