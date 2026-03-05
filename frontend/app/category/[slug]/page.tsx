"use client";

import { use } from "react";
import DiscoveryPageClient from "@/components/DiscoveryPageClient";

function toCategoryLabel(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export default function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const category = toCategoryLabel(slug);

  return (
    <DiscoveryPageClient
      title={`CATEGORY · ${category.toUpperCase()}`}
      subtitle="Category-focused market discovery"
      fixedCategory={category}
    />
  );
}
