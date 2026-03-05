import DiscoveryPageClient from "@/components/DiscoveryPageClient";
import { categoryFromSlug, type DiscoverySort } from "@/lib/discovery";

function toSort(value: string | undefined): DiscoverySort {
  if (value === "volume_asc") return value;
  if (value === "ending_soon") return value;
  if (value === "newest") return value;
  return "volume_desc";
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; sort?: string; tag?: string }>;
}) {
  const { slug } = await params;
  const { q, sort, tag } = await searchParams;
  const category = categoryFromSlug(slug);

  return (
    <DiscoveryPageClient
      title={`CATEGORY · ${category.toUpperCase()}`}
      subtitle="Category-focused market discovery"
      fixedCategory={category}
      initialQuery={q ?? ""}
      initialSort={toSort(sort)}
      initialTag={tag ?? "all"}
    />
  );
}
