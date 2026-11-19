import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button.tsx";
import { ProposalItems, type ProposalView } from "./ProposalItems.tsx";

export function RecordedProposalScope({ proposal, defaultOpen = false }: { proposal: ProposalView; defaultOpen?: boolean }) {
  const { t } = useTranslation("questions");
  const [open, setOpen] = useState(defaultOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const refused = proposal.items.filter((item) => item.used && !item.pending && item.failed).length;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} onKeyDown={(event) => {
      if (open && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        trigger.current?.focus({ preventScroll: true });
        setOpen(false);
      }
    }}>
      {refused > 0 && <p className="mb-1 text-[13px] text-danger">{t("proposal.refusedCount", { count: refused })}</p>}
      <Collapsible.Trigger asChild>
        <Button ref={trigger} type="button" variant="outline" className="group">
          {t("proposal.changeCount", { count: proposal.items.length })}
          <ChevronDown aria-hidden className="group-data-[state=open]:rotate-180" />
        </Button>
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-2 rounded-lg bg-soft p-3">
        <ProposalItems proposal={proposal} />
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
