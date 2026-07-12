"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { onboardAndAnalyze, type OnboardingState } from "@/app/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: OnboardingState = { error: null };

const PLATFORMS = [
  { value: "woocommerce", label: "WooCommerce" },
  { value: "shopify", label: "Shopify" },
  { value: "wix", label: "Wix" },
  { value: "custom", label: "Custom-built" },
  { value: "other", label: "Other" },
];

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Saving…" : "Analyze My Store"}
    </Button>
  );
}

/** Client-side check only guards against an obviously-malformed URL before a
 *  round trip; the Server Action re-validates independently (never trust
 *  client-only validation) — see actions.ts. */
function isLikelyValidUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    new URL(value.includes("://") ? value : `https://${value}`);
    return true;
  } catch {
    return false;
  }
}

export function OnboardingForm() {
  const [state, formAction] = useActionState(onboardAndAnalyze, initialState);

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-2xl">Add your store</CardTitle>
        <CardDescription>We&apos;ll check its UCP compliance and AI-agent readability.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={formAction}
          onSubmit={(e) => {
            const url = (e.currentTarget.elements.namedItem("rootUrl") as HTMLInputElement)?.value ?? "";
            if (!isLikelyValidUrl(url)) {
              e.preventDefault();
              alert("Please enter a valid store URL.");
            }
          }}
          className="flex flex-col gap-6"
        >
          <div className="grid gap-2">
            <Label htmlFor="rootUrl">Store URL</Label>
            <Input id="rootUrl" name="rootUrl" type="text" placeholder="https://yourstore.com" required />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="platform">Platform</Label>
            <select
              id="platform"
              name="platform"
              required
              defaultValue=""
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="" disabled>
                Select a platform…
              </option>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="feedUrl">Product feed URL (optional)</Label>
            <Input id="feedUrl" name="feedUrl" type="text" placeholder="https://yourstore.com/products.json" />
          </div>

          <div className="flex flex-col gap-3 border-t pt-4">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="identityLinkingOptOut" className="mt-1" />
              <span>I don&apos;t want to link shopper identity across AI agent sessions.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="checkoutHandoffOptIn" className="mt-1" />
              <span>Hand off checkout to my own site instead of declaring UCP checkout directly.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="aiTrainingOptOut" className="mt-1" />
              <span>I&apos;ve deliberately blocked AI training crawlers (GPTBot, ClaudeBot) on purpose.</span>
            </label>
          </div>

          {state.error && <p className="text-sm text-red-500">{state.error}</p>}

          <SubmitButton />
        </form>
      </CardContent>
    </Card>
  );
}
