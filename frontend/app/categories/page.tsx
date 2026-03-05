"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import WalletButton from "@/components/WalletButton";
import type { DiscoveryCategorySummary } from "@/lib/discovery";

interface CategoriesResponse {
  categories: DiscoveryCategorySummary[];
  total: number;
}

function formatCompactUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<DiscoveryCategorySummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/categories?limit=180", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: CategoriesResponse) => setCategories(data.categories ?? []))
      .catch(() => setCategories([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border px-4 md:px-6 py-4 bg-surface/30 backdrop-blur-[2px] flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[11px] text-muted hover:text-text tracking-widest uppercase">
            ← Markets
          </Link>
          <h1 className="text-xl font-black text-text tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            CATEGORIES
          </h1>
        </div>
        <WalletButton />
      </header>

      <main className="flex-1 px-4 md:px-6 py-6">
        <p className="text-[11px] text-muted-dim tracking-widest uppercase mb-4">
          Browse active market clusters by aggregate volume
        </p>

        {loading ? (
          <div className="py-8 flex justify-center">
            <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : categories.length === 0 ? (
          <div className="border border-border bg-surface/25 px-4 py-6 text-center">
            <p className="text-sm text-muted">No categories available.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-border/90 shadow-[0_0_0_1px_rgba(78,163,255,0.08)]">
            {categories.map((category, index) => (
              <Link
                key={category.slug}
                href={`/category/${category.slug}`}
                className="group bg-bg px-4 py-4 border border-transparent hover:border-accent/45 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] text-muted-dim tracking-widest uppercase mb-1">
                      Rank #{index + 1}
                    </p>
                    <h2 className="text-base font-black text-text tracking-tight group-hover:text-accent transition-colors">
                      {category.name}
                    </h2>
                  </div>
                  <span className="text-[10px] text-muted border border-border px-2 py-1 tracking-widest uppercase">
                    {category.eventCount} Events
                  </span>
                </div>
                <div className="mt-4">
                  <p className="text-[10px] text-muted-dim tracking-widest uppercase">Total Volume</p>
                  <p className="text-lg font-black text-blue" style={{ fontFamily: "var(--font-display)" }}>
                    {formatCompactUsd(category.totalVolume)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
