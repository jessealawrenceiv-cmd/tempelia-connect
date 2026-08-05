import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, FileUp, ShieldAlert, X } from "lucide-react";
import {
  IMPORT_ATTESTATION_TEXT,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  autoDetectMapping,
  dedupeWithinFile,
  mapRows,
  parseCsv,
  summaryHeadline,
  validateMapping,
  type ColumnMapping,
  type ImportField,
  type ImportSummary,
  type ParsedCsv,
} from "@/lib/contact-import";
import { commitContactImport, listContactImportEvents } from "@/lib/contact-import.functions";

type Step = "upload" | "map" | "done";

export function ContactImportPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [attested, setAttested] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  const commit = useServerFn(commitContactImport);
  const listEvents = useServerFn(listContactImportEvents);

  const { data: events } = useQuery({
    queryKey: ["contact-import-events"],
    queryFn: () => listEvents(),
  });

  const mapCheck = useMemo(() => validateMapping(mapping), [mapping]);
  const rows = useMemo(() => (parsed ? mapRows(parsed, mapping) : []), [parsed, mapping]);
  const deduped = useMemo(() => dedupeWithinFile(rows), [rows]);
  const validRows = deduped.rows.filter((r) => !r.error);
  const skippedRows = deduped.rows.filter((r) => r.error);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("That file is larger than 5 MB. Split it into smaller exports.");
      return;
    }
    const text = await file.text();
    const p = parseCsv(text);
    if (!p.headers.length || !p.rows.length) {
      toast.error("No data rows found in that file.");
      return;
    }
    setFileName(file.name);
    setParsed(p);
    setMapping(autoDetectMapping(p.headers));
    setAttested(false);
    setSummary(null);
    setStep("map");
  };

  const run = useMutation({
    mutationFn: async () => {
      const columnMapping: Record<string, string> = {};
      (parsed?.headers ?? []).forEach((h, i) => {
        const f = mapping[i];
        if (f) columnMapping[h] = f;
      });
      return commit({
        data: {
          fileName,
          columnMapping,
          attestationAccepted: true,
          rows: deduped.rows,
        },
      });
    },
    onSuccess: (res) => {
      setSummary({ ...res.summary, collapsedDuplicates: deduped.collapsed });
      setEventId(res.eventId);
      setStep("done");
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact-import-events"] });
      toast.success(summaryHeadline({ ...res.summary, collapsedDuplicates: deduped.collapsed }));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canImport = mapCheck.ok && attested && validRows.length > 0 && !run.isPending;

  return (
    <div className="panel p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">// bulk intake</div>
          <h2 className="font-display text-xl uppercase tracking-wide">Import contacts from CSV</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Bring an existing customer list over from another platform. Map your file's columns to Temaro fields,
            preview the result, then commit.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close import" className="rounded-sm border border-border p-1 text-muted-foreground hover:text-paper">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Consent rule — non-negotiable, stated up front */}
      <div className="flex gap-3 rounded-sm border border-violet/40 bg-violet/10 p-3 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div>
          <div className="font-display uppercase tracking-wider text-xs">SMS consent is never imported</div>
          <p className="mt-1 text-muted-foreground">
            Every imported contact lands with <span className="mono">no SMS consent</span> and{" "}
            <span className="mono">no signed consent form</span>, regardless of any column in your file that claims
            otherwise. Being a customer in your old software isn't consent to receive automated texts through Temaro.
            Consent is collected here, through your intake form or a YES reply.
          </p>
        </div>
      </div>

      {step === "upload" && (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-sm border border-dashed border-border bg-background/50 px-6 py-10 text-sm text-muted-foreground hover:border-primary"
          >
            <FileUp className="h-6 w-6 text-primary" />
            <span className="font-display uppercase tracking-wider text-paper">Choose a CSV file</span>
            <span className="mono text-[11px]">any column order · any header names · up to 5 MB</span>
          </button>
        </div>
      )}

      {step === "map" && parsed && (
        <div className="space-y-5">
          <div className="mono text-[11px] uppercase tracking-widest text-muted-foreground">
            // {fileName} · {parsed.rows.length} data rows · {parsed.headers.length} columns
          </div>

          {/* Column mapping */}
          <div className="overflow-hidden rounded-sm border border-border">
            <table className="w-full text-sm">
              <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left">Column in your file</th>
                  <th className="px-3 py-2 text-left">First value</th>
                  <th className="px-3 py-2 text-left">Temaro field</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((h, i) => (
                  <tr key={`${h}-${i}`} className="border-b border-border/50">
                    <td className="px-3 py-2 mono text-xs">{h}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate max-w-[14rem]">
                      {parsed.rows[0]?.[i]?.trim() || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Map column ${h}`}
                        value={mapping[i] ?? ""}
                        onChange={(e) =>
                          setMapping((prev) => ({ ...prev, [i]: e.target.value as ImportField | "" }))
                        }
                        className="mono w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
                      >
                        <option value="">— ignore this column —</option>
                        {IMPORT_FIELDS.map((f) => (
                          <option key={f} value={f}>{IMPORT_FIELD_LABELS[f]}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!mapCheck.ok && (
            <div className="flex items-center gap-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <span>{mapCheck.error}</span>
            </div>
          )}

          {/* Preview */}
          {mapCheck.ok && (
            <div className="space-y-2">
              <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                // preview · first {Math.min(5, validRows.length)} of {validRows.length} importable rows
              </div>
              <div className="overflow-x-auto rounded-sm border border-border">
                <table className="w-full text-sm">
                  <thead className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 text-left">Row</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Phone (E.164)</th>
                      <th className="px-3 py-2 text-left">Email</th>
                      <th className="px-3 py-2 text-left">Notes</th>
                      <th className="px-3 py-2 text-left">SMS consent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validRows.slice(0, 5).map((r) => (
                      <tr key={r.rowNumber} className="border-b border-border/50">
                        <td className="px-3 py-2 mono text-xs text-muted-foreground">{r.rowNumber}</td>
                        <td className="px-3 py-2">
                          {[r.first_name, r.last_name].filter(Boolean).join(" ") || "Unnamed"}
                          {r.business_name && (
                            <span className="mono ml-2 text-[10px] text-muted-foreground">{r.business_name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 mono text-xs">{r.phone}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.email || "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground truncate max-w-[12rem]">{r.notes || "—"}</td>
                        <td className="px-3 py-2">
                          <span className="mono rounded-sm bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            none
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(skippedRows.length > 0 || deduped.collapsed > 0) && (
                <div className="rounded-sm border border-border bg-background/50 p-3 text-xs">
                  <div className="mono uppercase tracking-widest text-muted-foreground">
                    // {skippedRows.length} row(s) will be skipped
                    {deduped.collapsed > 0 && ` · ${deduped.collapsed} duplicate phone(s) merged within the file`}
                  </div>
                  <ul className="mt-2 space-y-1 text-muted-foreground max-h-32 overflow-y-auto">
                    {skippedRows.slice(0, 12).map((r) => (
                      <li key={r.rowNumber} className="mono">row {r.rowNumber}: {r.error}</li>
                    ))}
                    {skippedRows.length > 12 && <li className="mono">…and {skippedRows.length - 12} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Attestation */}
          <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-border bg-background/50 p-3 text-sm">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-violet"
            />
            <span>{IMPORT_ATTESTATION_TEXT}</span>
          </label>

          <div className="flex flex-wrap gap-3">
            <button
              disabled={!canImport}
              onClick={() => run.mutate()}
              className="rounded-sm bg-primary px-4 py-2 text-xs font-display uppercase tracking-wider text-primary-foreground disabled:opacity-40"
            >
              {run.isPending ? "Importing…" : `Import ${validRows.length} contact${validRows.length === 1 ? "" : "s"}`}
            </button>
            <button
              onClick={() => { setStep("upload"); setParsed(null); setAttested(false); }}
              className="rounded-sm border border-border px-4 py-2 text-xs font-display uppercase tracking-wider text-muted-foreground"
            >
              Choose a different file
            </button>
          </div>
        </div>
      )}

      {step === "done" && summary && (
        <div className="space-y-4">
          <div className="rounded-sm border border-primary/40 bg-primary/10 p-4">
            <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">// import summary</div>
            <div className="mt-1 font-display text-lg uppercase tracking-wide">{summaryHeadline(summary)}</div>
            <div className="mono mt-2 text-xs text-muted-foreground">
              {summary.totalRows} rows read · {summary.imported} new · {summary.updated} merged · {summary.matchedExisting} matched an existing contact · {summary.skipped} skipped
              {summary.collapsedDuplicates > 0 && ` · ${summary.collapsedDuplicates} in-file duplicate(s) merged`}
              {eventId && <> · log {eventId.slice(0, 8)}</>}
            </div>
          </div>
          {summary.skippedReasons.length > 0 && (
            <div className="rounded-sm border border-border p-3 text-xs">
              <div className="mono uppercase tracking-widest text-muted-foreground">// skipped rows</div>
              <ul className="mt-2 space-y-1 text-muted-foreground max-h-40 overflow-y-auto">
                {summary.skippedReasons.map((r) => (
                  <li key={r.rowNumber} className="mono">row {r.rowNumber}: {r.reason}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={() => { setStep("upload"); setParsed(null); setAttested(false); setSummary(null); }}
              className="rounded-sm border border-border px-4 py-2 text-xs font-display uppercase tracking-wider text-muted-foreground"
            >
              Import another file
            </button>
            <button
              onClick={onClose}
              className="rounded-sm bg-primary px-4 py-2 text-xs font-display uppercase tracking-wider text-primary-foreground"
            >
              Back to contacts
            </button>
          </div>
        </div>
      )}

      {/* Audit trail */}
      {(events?.length ?? 0) > 0 && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">// import log</div>
          <div className="space-y-2">
            {(events ?? []).map((e: any) => (
              <div key={e.id} className="rounded-sm border border-border bg-background/50 p-3 text-xs">
                <div className="mono flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                  <span className="text-paper">{new Date(e.occurred_at).toLocaleString()}</span>
                  <span>{e.file_name}</span>
                  <span>{e.imported_count} imported</span>
                  <span>{e.updated_count} merged</span>
                  <span>{e.skipped_count} skipped</span>
                  <span>of {e.total_rows} rows</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  <span className="mono uppercase tracking-wider text-[10px]">attested</span> “{e.attestation_text}”
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
