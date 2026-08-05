import { supabase } from "@/integrations/supabase/client";

export type TeamInviteEventType = "created" | "resent" | "accepted" | "revoked";

export type TeamInviteEvent = {
  id: string;
  team_member_id: string | null;
  actor_user_id: string | null;
  invited_email: string;
  event_type: string;
  detail: string | null;
  occurred_at: string;
};

/**
 * Append-only audit trail for staff invites. `detail` carries the acting
 * admin's email address (auth.users is not readable from the client), so the
 * history stays legible even after that admin's row changes.
 */
export async function logTeamInviteEvent(args: {
  businessOwnerId: string;
  teamMemberId: string | null;
  invitedEmail: string;
  eventType: TeamInviteEventType;
  detail?: string | null;
}) {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return;
  await supabase.from("team_invite_events").insert({
    business_owner_id: args.businessOwnerId,
    team_member_id: args.teamMemberId,
    actor_user_id: u.user.id,
    invited_email: args.invitedEmail.toLowerCase(),
    event_type: args.eventType,
    detail: args.detail ?? u.user.email ?? null,
  });
}

/** Latest audit entries for a business, newest first. */
export async function fetchTeamInviteEvents(businessOwnerId: string, limit = 50) {
  const { data, error } = await supabase
    .from("team_invite_events")
    .select("id, team_member_id, actor_user_id, invited_email, event_type, detail, occurred_at")
    .eq("business_owner_id", businessOwnerId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as TeamInviteEvent[];
}
