import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

const panel = "grid min-h-[50dvh] place-items-center px-5 text-center";

/** A route that threw, while loading or while rendering: a generic text (never the error's own) and a retry that runs the route's loading again. */
export function RouteError({ reset }: ErrorComponentProps) {
  const { t } = useTranslation("common");
  const router = useRouter();
  return (
    <div role="alert" className={panel}>
      <div>
        <p className="text-[17px] font-medium">{t("routeError.title")}</p>
        <p className="mt-1 text-[14px] text-muted">{t("errors.generic")}</p>
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          {t("routeError.retry")}
        </Button>
      </div>
    </div>
  );
}

/** A route that waits for more than a moment (the router shows it after its default delay). */
export function RoutePending() {
  const { t } = useTranslation("common");
  return (
    <p role="status" className={`${panel} text-[14px] text-muted`}>
      {t("loading")}
    </p>
  );
}

export function RouteNotFound() {
  const { t } = useTranslation("common");
  return (
    <div className={panel}>
      <div>
        <p className="text-[17px] font-medium">{t("notFound.title")}</p>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/">{t("notFound.link")}</Link>
        </Button>
      </div>
    </div>
  );
}

/** The router's defaults: every route has them unless it sets its own. */
export const routeStates = { defaultErrorComponent: RouteError, defaultPendingComponent: RoutePending, defaultNotFoundComponent: RouteNotFound };
