/**
 * Wire payload for the allowed `logs.action_type` values.
 *
 * Served by `/api/public/log-action-types` so UI code (including any client
 * that cannot import the generated enum directly) can build dropdowns that
 * only ever emit values the `logs_action_type_check` constraint accepts.
 */
import {
  LOG_ACTION_FILTER_ORDER,
  LOG_ACTION_PRESENTATION,
  isNewLogAction,
} from "@/lib/log-action-presentation";
import {
  LOGS_ACTION_TYPE_CONSTRAINT,
  LOG_ACTION_TYPES,
} from "@/lib/log-action-types.generated";

export type LogActionTypeOptionDto = {
  /** The exact `action_type` value to write to the database. */
  value: string;
  /** Radio-log style display label. */
  label: string;
  /** Plain-language description for tooltips/help text. */
  description: string;
  /** Tailwind class for the status dot, e.g. `bg-orange`. */
  dot: string;
  /** Semantic color token behind `dot`, e.g. `orange`. */
  dotToken: string;
  /** Recently added values are flagged so the UI can badge them. */
  isNew: boolean;
};

export type LogActionTypesResponseDto = {
  constraint: string;
  count: number;
  /** Flat whitelist, in database constraint order. */
  values: readonly string[];
  /** Display-ready options, in filter order (new values first). */
  options: readonly LogActionTypeOptionDto[];
};

export function buildLogActionTypesResponse(): LogActionTypesResponseDto {
  const options = LOG_ACTION_FILTER_ORDER.map((value) => {
    const meta = LOG_ACTION_PRESENTATION[value];
    return {
      value,
      label: meta.label,
      description: meta.description,
      dot: meta.dot,
      dotToken: meta.dot.replace(/^bg-/, ""),
      isNew: isNewLogAction(value),
    };
  });

  return {
    constraint: LOGS_ACTION_TYPE_CONSTRAINT,
    count: LOG_ACTION_TYPES.length,
    values: LOG_ACTION_TYPES,
    options,
  };
}
