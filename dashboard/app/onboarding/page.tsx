import { Suspense } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { OnboardingForm } from "@/components/onboarding-form";

// Uncached dynamic data (the auth check) must sit inside a Suspense boundary
// under Next 16's Cache Components — same pattern as /dashboard (see its
// header comment for why a naive top-level await here fails the build).
async function RequireAuth({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  // getClaims() cryptographically verifies the access token against our
  // project's asymmetric-signed JWKS — never a raw session/cookie read. Same
  // rationale as /dashboard and proxy.ts.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) {
    redirect("/auth/login");
  }

  return <>{children}</>;
}

export default function OnboardingPage() {
  return (
    <div className="flex-1 w-full flex flex-col items-center gap-6 py-8">
      <Suspense>
        <RequireAuth>
          <OnboardingForm />
        </RequireAuth>
      </Suspense>
    </div>
  );
}
