import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

const fetchShim = (key) => (input, init) => {
  const h = new Headers(init?.headers);
  if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
  h.set("apikey", key);
  return fetch(input, { ...init, headers: h });
};
const admin = createClient(URL, SVC, { auth: { persistSession: false }, global: { fetch: fetchShim(SVC) } });

const PW = "TeamTest!2026aX";
const stamp = Date.now();
const mk = (n) => `${n}.${stamp}@teamtest.temaro.io`;

async function newUser(email) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user.id;
}

async function signedInClient(email) {
  const c = createClient(URL, PUB, { auth: { persistSession: false }, global: { fetch: fetchShim(PUB) } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return c;
}

async function seed(uid, tag) {
  await admin.from("profiles").update({ business_name: `${tag} Co`, subscription_tier: "standard" }).eq("id", uid);
  const { data: cust, error: ce } = await admin.from("customers")
    .insert({ user_id: uid, first_name: `${tag}-Customer`, phone_number: `+1501000${Math.floor(Math.random() * 9000 + 1000)}`, opt_in_consent: true })
    .select().single();
  if (ce) throw new Error(`customers ${tag}: ${ce.message}`);
  const li = [{ label: "Prep", amount: 500 }];
  const { error: qe } = await admin.from("quotes").insert({
    user_id: uid, customer_id: cust.id, customer_first_name: `${tag}-Customer`,
    customer_phone: cust.phone_number, job_site_address: `1 ${tag} St`,
    line_items: li, subtotal: 500, tax_rate: 0, tax_amount: 0, total_amount: 500,
  });
  if (qe) throw new Error(`quotes ${tag}: ${qe.message}`);
  const { error: ae } = await admin.from("appointments").insert({
    user_id: uid, customer_id: cust.id, title: `${tag}-Appointment`, date: "2026-09-01", time: "09:00", duration_minutes: 120,
  });
  if (ae) throw new Error(`appointments ${tag}: ${ae.message}`);
  await admin.from("jobs").insert({ user_id: uid, customer_id: cust.id, status: "pending", job_value: 500 });
  await admin.from("intake_submissions").insert({
    user_id: uid, customer_first_name: `${tag}-Customer`, customer_last_name: "Test", customer_phone: cust.phone_number,
  });
  await admin.from("logs").insert({ user_id: uid, customer_id: cust.id, action_type: "test", message_sent: `${tag} log line` });
  await admin.from("excluded_numbers").insert({ user_id: uid, phone_number: `+1888000${Math.floor(Math.random() * 9000 + 1000)}`, label: `${tag} excluded` });
  await admin.from("subscriptions").insert({
    user_id: uid, stripe_subscription_id: `sub_${tag}_${stamp}`, stripe_customer_id: `cus_${tag}_${stamp}`,
    product_id: "prod_test", price_id: "price_test", status: "active", environment: "sandbox",
  });
  return cust.id;
}

function show(label, res) {
  if (res.error) console.log(`${label}: ERROR ${res.error.code ?? ""} ${res.error.message}`);
  else console.log(`${label}: rows=${res.data.length} ${JSON.stringify(res.data)}`);
}

const emails = { a: mk("ownerA"), b: mk("ownerB"), staff: mk("staffA"), starter: mk("ownerStarter") };
const ownerA = await newUser(emails.a);
const ownerB = await newUser(emails.b);
const staffA = await newUser(emails.staff);
const ownerStarter = await newUser(emails.starter);
console.log("users:", { ownerA, ownerB, staffA, ownerStarter });

await seed(ownerA, "BIZ-A");
await seed(ownerB, "BIZ-B");
await admin.from("profiles").update({ subscription_tier: "starter", business_name: "Starter Co" }).eq("id", ownerStarter);

// Owner A (standard) creates the invite through a real signed-in session
const ownerAClient = await signedInClient(emails.a);
const inv = await ownerAClient.from("team_members")
  .insert({ business_owner_id: ownerA, invited_email: emails.staff, role: "staff" }).select();
console.log("\n== invite created by Standard owner ==");
show("team_members insert", inv);

// Staff signs in, claims the invite
const staff = await signedInClient(emails.staff);
const claim = await staff.rpc("claim_team_invites");
console.log("claim_team_invites ->", claim.data, claim.error?.message ?? "");
show("staff sees own membership row", await staff.from("team_members").select("business_owner_id, invited_email, accepted_at"));

console.log("\n=== TEST A: staff reads OWN business data ===");
show("customers", await staff.from("customers").select("id, first_name, user_id"));
show("quotes", await staff.from("quotes").select("id, customer_first_name, total_amount, user_id"));
show("appointments", await staff.from("appointments").select("id, title, date, time, user_id"));
show("jobs", await staff.from("jobs").select("id, status, user_id"));
show("intake_submissions", await staff.from("intake_submissions").select("id, customer_first_name, user_id"));
show("logs", await staff.from("logs").select("id, message_sent, user_id"));

console.log("\n=== TEST B: staff attempts owner-only tables ===");
show("profiles", await staff.from("profiles").select("id, business_name, subscription_tier"));
show("subscriptions", await staff.from("subscriptions").select("id, user_id, status"));
show("excluded_numbers", await staff.from("excluded_numbers").select("id, phone_number, user_id"));

console.log("\n=== TEST C: staff attempts BIZ-B (second, unrelated business) ===");
show("BIZ-B customers", await staff.from("customers").select("id, first_name, user_id").eq("user_id", ownerB));
show("BIZ-B quotes", await staff.from("quotes").select("id, customer_first_name, user_id").eq("user_id", ownerB));
show("BIZ-B appointments", await staff.from("appointments").select("id, title, user_id").eq("user_id", ownerB));
show("BIZ-B write attempt", await staff.from("customers").insert({ user_id: ownerB, first_name: "Intruder", phone_number: "+15010000001" }).select());

console.log("\n=== TEST D: Starter-tier owner attempts an invite ===");
const starterClient = await signedInClient(emails.starter);
show("starter team_members insert", await starterClient.from("team_members")
  .insert({ business_owner_id: ownerStarter, invited_email: `helper.${stamp}@teamtest.temaro.io` }).select());
show("starter team_members after attempt", await starterClient.from("team_members").select("*"));

console.log("\n(cleanup)");
for (const id of [ownerA, ownerB, staffA, ownerStarter]) await admin.auth.admin.deleteUser(id);
console.log("test users deleted");
