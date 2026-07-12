## Plan: Connect Tempelia to GitHub

### Goal
Back up the Tempelia codebase and enable two-way sync with a GitHub repository so you can collaborate, review code, and optionally deploy externally.

### Background
The project is currently only stored in Lovable's internal git storage. No GitHub remote is configured. The codebase is a TanStack Start + Supabase app with Stripe, Twilio, and role-based admin features.

### Steps

1. **Open the GitHub connection flow in Lovable**
   - In the Lovable editor, click the **Plus (+) menu** in the chat input (bottom left).
   - Choose **GitHub → Connect project**.

2. **Authorize the Lovable GitHub App**
   - You will be redirected to GitHub to authorize the Lovable GitHub App.
   - Grant access to the account or organization where you want the repo created.

3. **Select target account and create repository**
   - Choose the GitHub account/organization.
   - Name the repository (suggested: `tempelia`).
   - Click **Create Repository** in Lovable.

4. **Verify initial sync**
   - Lovable will push the current codebase to the new GitHub repo.
   - Open the repo on GitHub and confirm all files are present.

5. **Post-connection recommendations**
   - Enable branch switching in Lovable if needed: Account Settings → Labs → GitHub Branch Switching.
   - Decide on external hosting (optional): the code can be deployed outside Lovable after GitHub sync, but environment variables and Lovable Cloud backend would need to be reconfigured elsewhere.

### Notes / considerations
- This is **Git sync**, not the GitHub connector for app automations.
- No code changes are required in the project to enable sync.
- Secrets (Twilio, Stripe, Supabase service role) are **not** synced to GitHub. You will need to reconfigure them in any external hosting environment.
- Database data is exported separately via Cloud → Advanced settings → Export data if needed.

### Success criteria
- A GitHub repository exists with the Tempelia codebase.
- Future edits in Lovable push to GitHub automatically.
- Future pushes to GitHub sync back to Lovable.