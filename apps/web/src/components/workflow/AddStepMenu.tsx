import type { StepType } from "@dispand/domain/workflows/model";
import { Bot, Database, GitBranch, Plus, Repeat, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** The step types the canvas can add, in menu order. */
const choices: { type: StepType; label: string; icon: LucideIcon }[] = [
  { type: "agent", label: "Agent", icon: Bot },
  { type: "data", label: "Data", icon: Database },
  { type: "condition", label: "Condition", icon: GitBranch },
  { type: "loop", label: "For each", icon: Repeat },
];

/** A "+" that opens the list of step types (not "For each" inside a loop); picking one calls `onPick`. */
export function AddStepMenu({
  onPick,
  label,
  className,
  inLoop = false,
}: {
  onPick: (type: StepType) => void;
  label: string;
  className?: string;
  /** Inside a loop's body: no "For each" (loops can't be nested yet). */
  inLoop?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          // React bubbles clicks through portals too: the card under it mustn't take them as a select.
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "nodrag nopan pointer-events-auto grid size-6 place-items-center rounded-full bg-surface text-accent shadow-card ring-1 ring-line transition hover:bg-hover",
            className,
          )}
        >
          <Plus size={14} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-44 rounded-xl border-0 p-2 shadow-pop" onClick={(e) => e.stopPropagation()}>
        {choices.filter((c) => !inLoop || c.type !== "loop").map(({ type, label, icon: Icon }) => (
          <DropdownMenuItem key={type} onSelect={() => onPick(type)} className="text-[13px]">
            <Icon aria-hidden /> {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
