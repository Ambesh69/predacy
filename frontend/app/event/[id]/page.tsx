"use client";

import dynamic from "next/dynamic";

const EventPageClient = dynamic(
  () => import("@/components/EventPageClient"),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    ),
  },
);

export default function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <EventPageClient params={params} />;
}
