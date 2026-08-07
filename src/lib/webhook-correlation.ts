/**
 * How correlation state between an inbound webhook hit and the Activity log
 * entry it produced is presented in the dashboard.
 *
 * Kept separate from the panel so both the UI and its tests read the same
 * labels, and so the wording for a flagged failure is defined in one place.
 */
export type CorrelationState = "pending" | "correlated" | "missing" | "not_applicable";

export const CORRELATION_STATES: readonly CorrelationState[] = [
  "pending",
  "correlated",
  "missing",
  "not_applicable",
] as const;

type Presentation = {
  /** Short badge text shown on the event row. */
  label: string;
  /** Tooltip / expanded explanation. */
  description: string;
  /** Semantic colour token class (no raw colours). */
  tone: string;
  /** True for states that need an owner's attention. */
  isFailure: boolean;
};

export const CORRELATION_PRESENTATION: Record<CorrelationState, Presentation> = {
  pending: {
    label: "linking",
    description: "Waiting to be matched with the activity entry this call produced",
    tone: "text-muted-foreground",
    isFailure: false,
  },
  correlated: {
    label: "logged",
    description: "Matched with the activity entry this call produced",
    tone: "text-moss",
    isFailure: false,
  },
  missing: {
    label: "no log",
    description: "This call produced no activity entry — flagged for review",
    tone: "text-destructive",
    isFailure: true,
  },
  not_applicable: {
    label: "n/a",
    description: "No activity entry expected for this hit",
    tone: "text-muted-foreground",
    isFailure: false,
  },
};

/** Normalises any DB value (including unknown future states) to a known state. */
export function correlationState(value: string | null | undefined): CorrelationState {
  return CORRELATION_STATES.includes(value as CorrelationState)
    ? (value as CorrelationState)
    : "pending";
}

export function correlationPresentation(value: string | null | undefined): Presentation {
  return CORRELATION_PRESENTATION[correlationState(value)];
}

/** Correlation only applies to missed-call hits today. */
export function correlationApplies(eventKind: string): boolean {
  return eventKind === "missed_call";
}

/** Count of hits that need attention, for the panel's summary line. */
export function countCorrelationFailures(
  rows: readonly { event_kind: string; correlation_state?: string | null }[],
): number {
  return rows.filter(
    (r) => correlationApplies(r.event_kind) && correlationPresentation(r.correlation_state).isFailure,
  ).length;
}
