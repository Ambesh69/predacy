"use client";

import dynamic from "next/dynamic";

const ProfileClient = dynamic(() => import("@/components/ProfileClient"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

export default function ProfilePage() {
  return <ProfileClient />;
}
