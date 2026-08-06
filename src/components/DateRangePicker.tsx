"use client";

import * as React from "react";
import { format, startOfDay, endOfDay } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface DateRangeValue {
  from?: Date;
  to?: Date;
}

interface DateRangePickerProps {
  value: DateRangeValue | undefined;
  onChange: (value: DateRangeValue | undefined) => void;
  placeholder?: string;
  presets?: { label: string; days: number }[];
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = "Pick a date range",
  presets = [
    { label: "Today", days: 0 },
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
  ],
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);

  const range: DateRange | undefined = React.useMemo(
    () =>
      value?.from
        ? { from: value.from, to: value.to }
        : undefined,
    [value],
  );

  const displayText = React.useMemo(() => {
    if (!value?.from) return placeholder;
    if (value.to) {
      return `${format(value.from, "MMM d")} — ${format(value.to, "MMM d")}`;
    }
    return `From ${format(value.from, "MMM d")}`;
  }, [value, placeholder]);

  const applyPreset = (days: number) => {
    const to = endOfDay(new Date());
    const from = startOfDay(new Date());
    from.setDate(from.getDate() - days);
    onChange({ from, to });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={value?.from ? `Date range: ${displayText}` : placeholder}
          className={cn(
            "kb-focus h-7 justify-start gap-2 rounded-full border border-border bg-background px-3 text-xs font-normal text-foreground hover:bg-muted hover:text-foreground",
            !value?.from && "text-muted-foreground",
          )}
        >
          <CalendarIcon size={12} />
          <span className="truncate">{displayText}</span>
          {value?.from && (
            <span
              role="button"
              aria-label="Clear date range"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onChange(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onChange(undefined);
                }
              }}
              className="kb-focus ml-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="pointer-events-auto flex flex-col gap-3">
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset.days)}
                  className="kb-focus rounded-full bg-muted px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
          <Calendar
            mode="range"
            selected={range}
            onSelect={(next) => {
              onChange(
                next?.from
                  ? { from: next.from, to: next.to }
                  : undefined,
              );
              if (next?.from && next?.to) {
                setOpen(false);
              }
            }}
            numberOfMonths={1}
            initialFocus
            className="p-0"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
