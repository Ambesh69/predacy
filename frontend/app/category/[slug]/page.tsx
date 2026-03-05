import DiscoveryPageClient from "@/components/DiscoveryPageClient";
import { categoryFromSlug } from "@/lib/discovery";

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const category = categoryFromSlug(slug);

  return (
    <DiscoveryPageClient
      title={`CATEGORY · ${category.toUpperCase()}`}
      subtitle="Category-focused market discovery"
      fixedCategory={category}
    />
  );
}
