import { createClient } from "@supabase/supabase-js";
import { checkInboundEngagement } from "/dev-server/src/lib/inbound-engagement.server.ts";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const uid = "7d429771-e89a-4587-95a4-f7cf9d1e7cb5";
const cases = [
  { label: "CSV-imported, never engaged", id: "344d67a7-7c88-400b-a908-037f1921bc60", phone: "+14155550777" },
  { label: "Priya — real inbound on record, not opted in", id: "135ee8c0-9e17-40a5-9cf0-9fb99cefcc1d", phone: "+14155550103" },
];
for (const c of cases) {
  const r = await checkInboundEngagement(sb as any, uid, { id: c.id, phone_number: c.phone });
  console.log(c.label, "=>", JSON.stringify(r));
}
