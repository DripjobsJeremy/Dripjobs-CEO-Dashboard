/**
 * DripJobs CEO Dashboard — ClickUp Data Updater
 *
 * Runs every morning at 7 AM EST via GitHub Actions.
 * Reads tasks from ClickUp and writes ../data.json.
 *
 * Required GitHub Secrets (Settings → Secrets → Actions):
 *   CLICKUP_API_TOKEN       — Your ClickUp personal API token
 *                             (Settings → Apps → API Token)
 *   CLICKUP_TEAM_ID         — Your Workspace ID (shown in ClickUp URL)
 *   CLICKUP_FEATURES_LIST_ID — List ID for features / dev tasks
 *   CLICKUP_BUGS_LIST_ID     — List ID for bugs
 *
 * ClickUp Status conventions assumed (update STATUSES below to match yours):
 *   Done statuses:       "complete", "done", "closed"
 *   In-progress statuses: "in progress", "in review", "in qa"
 *   Bug tag:             tasks tagged "bug" in the bugs list
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN   = process.env.CLICKUP_API_TOKEN;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const FEATURES_LIST = process.env.CLICKUP_FEATURES_LIST_ID;
const BUGS_LIST     = process.env.CLICKUP_BUGS_LIST_ID;

// ── Customize these to match your ClickUp status names ──────────────────────
const DONE_STATUSES        = ['complete', 'done', 'closed', 'shipped'];
const IN_PROGRESS_STATUSES = ['in progress', 'in review', 'in qa', 'dev', 'review'];
// ────────────────────────────────────────────────────────────────────────────

if (!TOKEN || !TEAM_ID) {
  console.error('❌ Missing CLICKUP_API_TOKEN or CLICKUP_TEAM_ID. Check GitHub Secrets.');
  process.exit(1);
}

async function clickup(path, params = {}) {
  const url = new URL(`https://api.clickup.com/api/v2${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: TOKEN },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

// Returns Unix timestamp for N days ago
function daysAgo(n) {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

async function getListTasks(listId, extraParams = {}) {
  if (!listId) return [];
  const data = await clickup(`/list/${listId}/task`, {
    include_closed: true,
    ...extraParams,
  });
  return data.tasks || [];
}

async function main() {
  console.log('🔄 Fetching ClickUp data…');

  const sevenDaysAgo = daysAgo(7);

  // ── Features list ──────────────────────────────────────────────────────────
  const [allFeatureTasks, allBugTasks] = await Promise.all([
    getListTasks(FEATURES_LIST),
    getListTasks(BUGS_LIST),
  ]);

  const isDone = t => DONE_STATUSES.includes(t.status?.status?.toLowerCase());
  const isInProgress = t => IN_PROGRESS_STATUSES.includes(t.status?.status?.toLowerCase());
  const completedRecently = t => isDone(t) && Number(t.date_closed) >= sevenDaysAgo;

  // Stats
  const featuresShipped = allFeatureTasks.filter(completedRecently).length;
  const inProgress      = allFeatureTasks.filter(isInProgress).length;
  const tasksClosed     = [...allFeatureTasks, ...allBugTasks].filter(completedRecently).length;

  // Bugs
  const openBugs      = allBugTasks.filter(t => !isDone(t)).length;
  const bugsNew       = allBugTasks.filter(t => Number(t.date_created) >= sevenDaysAgo).length;
  const bugsResolved  = allBugTasks.filter(completedRecently).length;
  const bugsDeferred  = allBugTasks.filter(t =>
    t.status?.status?.toLowerCase() === 'deferred'
  ).length;

  // QA Pass Rate: completed features / (completed features + bug-tagged completed in period)
  const bugsClosedThisWeek = allBugTasks.filter(completedRecently).length;
  const totalShipped = featuresShipped + bugsClosedThisWeek;
  const qaPassRate = totalShipped > 0
    ? Math.round((featuresShipped / totalShipped) * 100)
    : 100;

  // ── Recent activity (last 5 completed tasks across both lists) ─────────────
  const recent = [...allFeatureTasks, ...allBugTasks]
    .filter(t => isDone(t) && t.date_closed)
    .sort((a, b) => Number(b.date_closed) - Number(a.date_closed))
    .slice(0, 5)
    .map(t => ({
      title: t.name,
      status: t.status?.status,
      closedAt: new Date(Number(t.date_closed)).toISOString(),
      url: t.url,
    }));

  const data = {
    lastUpdated: new Date().toISOString(),
    stats: {
      featuresShipped,
      qaPassRate,
      inProgress,
      openBugs,
      tasksClosed,
    },
    bugs: {
      newThisWeek: bugsNew,
      resolved: bugsResolved,
      open: openBugs,
      deferred: bugsDeferred,
    },
    recentActivity: recent,
  };

  const outPath = resolve(__dirname, '..', 'data.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('✅ data.json updated:');
  console.log(`   Features shipped : ${featuresShipped}`);
  console.log(`   In progress      : ${inProgress}`);
  console.log(`   Open bugs        : ${openBugs}`);
  console.log(`   Tasks closed     : ${tasksClosed}`);
  console.log(`   QA pass rate     : ${qaPassRate}%`);
}

main().catch(err => {
  console.error('❌ Update failed:', err.message);
  process.exit(1);
});
