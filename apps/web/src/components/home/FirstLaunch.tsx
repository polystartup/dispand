import { Link } from "@tanstack/react-router";
import { Compass, Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";

type Status = { hasHarness: boolean; hasAgent: boolean };

/** Where "Start from scratch" goes: the first step still missing. */
function nextStep({ hasHarness, hasAgent }: Status) {
  if (!hasHarness) return "/settings/harnesses" as const;
  if (!hasAgent) return "/settings/agents/new" as const;
  return "/settings/workflows" as const;
}

/** Home before anything is set up: two ways in, one clear primary action. */
export function FirstLaunch({ status }: { status: Status }) {
  return (
    <section aria-labelledby="first-launch-title" className="mx-auto max-w-xl rounded-3xl bg-surface px-6 py-14 text-center shadow-card sm:px-12">
      <h2 id="first-launch-title" className="text-[24px] font-semibold tracking-tight">
        Let's set up your first workflow
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-[15px] text-muted">
        Connect a harness, create an agent and put a workflow on Home. It takes a few minutes.
      </p>
      <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
        <Button size="lg" asChild>
          <Link to={nextStep(status)}>
            <Hammer aria-hidden />
            Start from scratch
          </Link>
        </Button>
        <Button size="lg" variant="outline" disabled>
          <Compass aria-hidden />
          Take the guided tour
        </Button>
      </div>
      <p className="mt-3 text-[13px] text-faint">The guided tour is coming soon.</p>
    </section>
  );
}
