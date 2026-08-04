import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type TeamRole = {
  loading: boolean;
  /** true when the signed-in user is staff working under another business owner */
  isStaff: boolean;
  /** the business owner's user id whose data this session can see */
  businessOwnerId: string | null;
};

/**
 * Resolves whether the current session is a staff login (accepted team_members row)
 * or the business owner itself. Staff logins never see Settings/Billing/Excluded numbers.
 */
export function useTeamRole(): TeamRole {
  const [state, setState] = useState<TeamRole>({ loading: true, isStaff: false, businessOwnerId: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        if (!cancelled) setState({ loading: false, isStaff: false, businessOwnerId: null });
        return;
      }
      // Link any pending invite for this email to the real auth uid.
      await supabase.rpc("claim_team_invites");

      const { data: membership } = await supabase
        .from("team_members")
        .select("business_owner_id, accepted_at")
        .eq("staff_user_id", u.user.id)
        .not("accepted_at", "is", null)
        .maybeSingle();

      if (cancelled) return;
      if (membership) {
        setState({ loading: false, isStaff: true, businessOwnerId: membership.business_owner_id });
      } else {
        setState({ loading: false, isStaff: false, businessOwnerId: u.user.id });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
