## Plan: Optional auto-refresh interval on the dashboard

### Goal
Let the business owner configure an automatic status re-evaluation interval on the Settings page so automation statuses refresh without clicking "Refresh now".

### What changes

1. **Database schema**
   - Add two columns to `public.profiles`:
     - `auto_refresh_enabled` boolean, default `false`
     - `auto_refresh_interval_minutes` integer, default `15`
   - Grant as part of the existing profiles permissions.

2. **Settings UI (Advanced section)**
   - Add an "Auto-refresh statuses" panel with:
     - Toggle to enable/disable.
     - Number input for interval in minutes (min 1, max 120).
     - Live summary of next scheduled refresh.
   - Persist changes immediately via the existing `profiles` update mutation.

3. **Auto-refresh behavior**
   - When enabled, start a timer that calls the existing `refreshStatuses()` function every N minutes.
   - Pause while the page is hidden (`document.visibilityState !== "visible"`).
   - Skip a tick if a manual refresh is already running or if the failure cooldown is active.
   - Stop the timer when disabled, the page is unmounted, or the user leaves the Settings tab.
   - Record each auto-refresh in the activity log with a distinct `trigger: "auto"` field so they can be filtered separately from manual refreshes.

4. **Realtime badge integration**
   - Auto-refresh counts as a "backend" origin update if it changes statuses.
   - The existing toast and activity-log flow remains unchanged.

5. **Tests**
   - Add a Playwright test that enables a short interval, waits for one auto-tick, and verifies the Activity log receives a `status_refresh` row with `trigger: "auto"`.

### Success criteria
- Owner can enable/disable auto-refresh and choose 1–120 minutes.
- With auto-refresh on, statuses re-evaluate on the interval while the Settings page is visible.
- Manual refresh and failure cooldown still take precedence and prevent overlapping runs.
- Each auto-run is auditable in the Activity log.
