/**
 * Export helpers for the operator "Export action types" control.
 *
 * Builds a JSON manifest or a SQL seed/reference file from the generated
 * action_type enum plus its presentation metadata (label, description, dot
 * color class), so the enum can be diffed or replayed outside the app.
 */
import { LOG_ACTION_PRESENTATION } from "@/lib/log-action-presentation";

export interface ActionTypeExportRow {
  actionType: string;
  label: string;
  description: string;
  dot: string;
  isNew: boolean;
  inDatabase: boolean;
}

export interface ActionTypeExportInput {
  constraintName: string;
  constraintDef: string | null;
  generatedValues: string[];
  dbValues: string[];
}

export function buildActionTypeRows(input: ActionTypeExportInput): ActionTypeExportRow[] {
  const dbSet = new Set(input.dbValues);
  return input.generatedValues.map((v) => {
    const p = LOG_ACTION_PRESENTATION[v as keyof typeof LOG_ACTION_PRESENTATION];
    return {
      actionType: v,
      label: p?.label ?? "",
      description: p?.description ?? "",
      dot: p?.dot ?? "",
      isNew: Boolean(p?.isNew),
      inDatabase: dbSet.has(v),
    };
  });
}

export function buildActionTypesJson(input: ActionTypeExportInput): string {
  return `${JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      constraintName: input.constraintName,
      constraintDef: input.constraintDef,
      count: input.generatedValues.length,
      actionTypes: buildActionTypeRows(input),
    },
    null,
    2,
  )}\n`;
}

const sqlQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function buildActionTypesSql(input: ActionTypeExportInput): string {
  const rows = buildActionTypeRows(input);
  const values = input.generatedValues.map((v) => sqlQuote(v)).join(",\n    ");

  const comments = rows
    .map(
      (r) =>
        `--   ${r.actionType.padEnd(32)} ${r.label || "—"}${r.dot ? ` [${r.dot}]` : ""}${
          r.inDatabase ? "" : "  (NOT IN DATABASE)"
        }\n--     ${r.description || "—"}`,
    )
    .join("\n");

  return `-- Temaro · activity log action types
-- Exported ${new Date().toISOString()}
-- Constraint: ${input.constraintName}
-- ${rows.length} value(s), generated enum + UI labels/colors
--
${comments}

ALTER TABLE public.logs DROP CONSTRAINT IF EXISTS ${input.constraintName};
ALTER TABLE public.logs ADD CONSTRAINT ${input.constraintName}
  CHECK (action_type IN (
    ${values}
  ));
`;
}

export function downloadTextFile(filename: string, mimeType: string, contents: string) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const actionTypesFilename = (ext: "json" | "sql") =>
  `temaro-action-types-${new Date().toISOString().slice(0, 10)}.${ext}`;
