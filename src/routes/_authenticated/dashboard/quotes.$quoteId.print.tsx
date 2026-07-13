import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/dashboard/quotes/$quoteId/print")({
  component: PrintQuotePage,
});

function money(n: number | string | null | undefined) {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return (v as number).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function fmtDate(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString() : "—";
}

function PrintQuotePage() {
  const { quoteId } = Route.useParams();

  const { data: quote, isLoading, error } = useQuery({
    queryKey: ["quote-print", quoteId],
    queryFn: async () => {
      const { data, error } = await supabase.from("quotes").select("*").eq("id", quoteId).single();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: profile } = useQuery({
    queryKey: ["print-profile"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("business_name, email, twilio_phone_number")
        .eq("id", u.user.id)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (quote) {
      // Auto-open the print dialog once content is on screen
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [quote]);

  if (isLoading) return <div className="p-8 mono text-sm">loading quote…</div>;
  if (error || !quote) return <div className="p-8 mono text-sm text-destructive">Quote not found.</div>;

  const items: Array<any> = Array.isArray(quote.line_items) ? quote.line_items : [];

  return (
    <>
      <style>{`
        @media print {
          @page { margin: 0.5in; }
          .no-print { display: none !important; }
          body { background: white !important; }
        }
        .print-sheet { background: white; color: #1a1a1a; }
        .print-sheet h1, .print-sheet h2 { color: #1a1a1a; }
      `}</style>
      <div className="min-h-screen bg-background p-4 md:p-8">
        <div className="no-print mb-4 flex justify-end gap-2 max-w-3xl mx-auto">
          <button
            onClick={() => window.print()}
            className="rounded-sm bg-primary px-4 py-2 text-xs font-display uppercase tracking-wider text-primary-foreground"
          >
            Print / Save as PDF
          </button>
          <button
            onClick={() => window.close()}
            className="rounded-sm border border-border px-4 py-2 text-xs uppercase tracking-wider"
          >
            Close
          </button>
        </div>

        <div className="print-sheet mx-auto max-w-3xl bg-white p-10 shadow-lg" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
          {/* Header */}
          <div className="flex items-start justify-between border-b-2 border-black pb-4">
            <div>
              <div style={{ fontFamily: 'Barlow Condensed, sans-serif' }} className="text-3xl font-bold uppercase tracking-wider text-[#6C4AB6]">
                {profile?.business_name || "QUOTE"}
              </div>
              {profile?.email && <div className="mono text-xs text-gray-600 mt-1">{profile.email}</div>}
              {profile?.twilio_phone_number && <div className="mono text-xs text-gray-600">{profile.twilio_phone_number}</div>}
            </div>
            <div className="text-right">
              <div style={{ fontFamily: 'Barlow Condensed, sans-serif' }} className="text-2xl font-bold uppercase tracking-widest">Quote</div>
              <div className="mono text-[10px] text-gray-600 mt-1">#{String(quote.id).slice(0, 8)}</div>
              <div className="mono text-[10px] text-gray-600">issued {fmtDate(quote.created_at)}</div>
              {quote.valid_until && <div className="mono text-[10px] text-gray-600">valid until {fmtDate(quote.valid_until)}</div>}
              <div className="mono text-[10px] uppercase tracking-wider mt-2 inline-block bg-gray-100 px-2 py-0.5">{quote.status}</div>
            </div>
          </div>

          {/* Customer + job */}
          <div className="grid grid-cols-2 gap-6 py-5 border-b border-gray-300">
            <div>
              <div className="mono text-[10px] uppercase tracking-widest text-gray-500 mb-1">Bill to</div>
              <div className="text-sm font-semibold">
                {[quote.customer_first_name, quote.customer_last_name].filter(Boolean).join(" ") || "—"}
              </div>
              {quote.customer_business_name && <div className="text-xs text-gray-700">{quote.customer_business_name}</div>}
              {quote.customer_phone && <div className="mono text-xs text-gray-700">{quote.customer_phone}</div>}
              {quote.billing_address && <div className="text-xs text-gray-700 whitespace-pre-line mt-1">{quote.billing_address}</div>}
            </div>
            <div>
              <div className="mono text-[10px] uppercase tracking-widest text-gray-500 mb-1">Job site</div>
              <div className="text-sm whitespace-pre-line">{quote.job_site_address}</div>
              <div className="mono text-[10px] text-gray-500 uppercase tracking-wider mt-2">
                {quote.job_type === "new_construction" ? "New construction" : "Existing building"}
                {quote.tax_exempt ? " · tax exempt" : ""}
              </div>
              {quote.po_number && <div className="mono text-xs text-gray-700 mt-1">PO # {quote.po_number}</div>}
            </div>
          </div>

          {quote.description && (
            <div className="py-4 border-b border-gray-300">
              <div className="mono text-[10px] uppercase tracking-widest text-gray-500 mb-1">Scope / notes</div>
              <div className="text-sm whitespace-pre-wrap">{quote.description}</div>
            </div>
          )}

          {/* Line items */}
          <table className="w-full text-sm my-6">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="text-left py-2 mono text-[10px] uppercase tracking-widest text-gray-600">Description</th>
                <th className="text-right py-2 mono text-[10px] uppercase tracking-widest text-gray-600">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={2} className="py-3 text-center text-gray-400 mono text-xs">no line items</td></tr>
              )}
              {items.map((li, i) => (
                <tr key={i} className="border-b border-gray-200">
                  <td className="py-2">{li.label || li.description || (li.key ? String(li.key).replace(/_/g, " ") : "—")}</td>
                  <td className="py-2 text-right mono">{money(li.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-64 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-gray-600">Subtotal</span><span className="mono">{money(quote.subtotal)}</span></div>
              <div className="flex justify-between">
                <span className="text-gray-600">
                  Tax {Number(quote.tax_rate) > 0 ? `(${Number(quote.tax_rate).toFixed(2)}%)` : ""}
                </span>
                <span className="mono">{money(quote.tax_amount)}</span>
              </div>
              <div className="flex justify-between border-t-2 border-black pt-2 mt-2" style={{ fontFamily: 'Barlow Condensed, sans-serif' }}>
                <span className="uppercase tracking-wider text-lg font-bold">Total</span>
                <span className="mono text-lg font-bold">{money(quote.total_amount)}</span>
              </div>
            </div>
          </div>

          <div className="mt-10 pt-4 border-t border-gray-300 text-[10px] text-gray-500 mono uppercase tracking-widest">
            Thank you — prepared by {profile?.business_name || "your contractor"}
          </div>
        </div>
      </div>
    </>
  );
}
