import { createClient } from "@supabase/supabase-js";
import { loadPromptContext, sendPromptToCustomer } from "../src/lib/opt-in-prompt.server.ts";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const uid = "7d429771-e89a-4587-95a4-f7cf9d1e7cb5";
const { profile, excludedDigits } = await loadPromptContext(sb as any, uid);
for (const [label, id] of [["CSV-imported, never engaged", "344d67a7-7c88-400b-a908-037f1921bc60"], ["Priya — genuinely called, never opted in", "135ee8c0-9e17-40a5-9cf0-9fb99cefcc1d"]] as const) {
  console.log(label, "=>", JSON.stringify(await sendPromptToCustomer(sb as any, uid, id, profile, excludedDigits)));
}
