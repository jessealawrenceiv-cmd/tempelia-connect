import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listContacts from "./tools/list_contacts";
import listQuotes from "./tools/list_quotes";
import listAppointments from "./tools/list_appointments";
import listRecentActivity from "./tools/list_missed_calls";

// Direct Supabase issuer — VITE_SUPABASE_PROJECT_ID is inlined at build time.
// SUPABASE_URL is rewritten to the .lovable.cloud proxy on publish, which
// mcp-js rejects as an issuer mismatch. See app-mcp-server-authoring.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "temora-mcp",
  title: "Temora",
  version: "0.1.0",
  instructions:
    "Read-only access to a signed-in Temora account: contacts, quotes, appointments, and dispatch activity. Every tool acts as the authenticated user via Supabase RLS.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listContacts, listQuotes, listAppointments, listRecentActivity],
});
