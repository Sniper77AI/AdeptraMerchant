import { Suspense } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/components/logout-button";

// Uncached dynamic data (the auth check below) must be read inside a
// Suspense boundary — Next 16's Cache Components build step otherwise
// errors: "Uncached data was accessed outside of <Suspense>." Splitting the
// auth check into its own async component (rendered via <Suspense> in the
// page below) is the same pattern the with-supabase template itself uses.
async function SignedInAs() {
  const supabase = await createClient();

  // Stage-1 placeholder route: the only job of this page is to prove a
  // server component can gate on a real, verified identity. getClaims()
  // verifies the access token's cryptographic signature against Supabase's
  // published JWKS (our project uses an asymmetric ES256 signing key, so
  // this is a local, non-spoofable check, not a network round trip) —
  // never trust an unverified cookie/session read here. Do not swap this
  // for getSession() or a raw cookie read.
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims) {
    redirect("/auth/login");
  }

  const email = data.claims.email as string;

  return (
    <p className="text-lg">
      Signed in as <span className="font-semibold">{email}</span>
    </p>
  );
}

export default function DashboardPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 items-start">
      <Suspense>
        <SignedInAs />
      </Suspense>
      <LogoutButton />
    </div>
  );
}
