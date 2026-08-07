"use client";

import * as React from "react";
import { format, startOfDay, subDays } from "date-fns";
import { CalendarSearch } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface JumpToDatePickerProps {
  /** Called with the day the user picked (local start of day). */
  onJump: (day: Date) => void;
  label?: string;
}

const QUICK_JUMPS = [
  { label: "Yesterday", days: 1 },
  { label: "1 week ago", days: 7 },
  { label: "1 month ago", days: 30 },
];

/**
 * Single-day jump control for the activity log. Picking a day narrows the log to
 * that day so older records are reachable without scrolling through everything
 * in between.
 */
export function JumpToDatePicker({ onJump, label = "Jump to date" }: JumpToDatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const today = React.useMemo(() => startOfDay(new Date()), []);

  const jump = (day: Date) => {
    onJump(startOfDay(day));
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={label}
          className={cn(
            "kb-focus h-7 justify-start gap-2 rounded-full border border-border bg-background px-3 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <CalendarSearch size={12} />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="pointer-events-auto flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_JUMPS.map((quick) => (
              <button
                key={quick.label}
                type="button"
                onClick={() => jump(subDays(today, quick.days))}
                className="kb-focus rounded-full bg-muted px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
              >
                {quick.label}
              </button>
            ))}
          </div>
          <Calendar
            mode="single"
            selected={undefined}
            onSelect={(day) => {
              if (day) jump(day);
            }}
            disabled={{ after: today }}
            defaultMonth={today}
            numberOfMonths={1}
            initialFocus
            className="p-0 pointer-events-auto"
          />
          <p className="max-w-[15rem] text-[10px] leading-relaxed text-muted-foreground">
            Shows {format(today, "MMM d")}-style single-day results. Widen with the date
            range control once you land.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
