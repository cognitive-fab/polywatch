// Money spent on the user's API accounts, per day, across all their projects. The daily cap
// (budgetUsdPerDay) bounds what a runaway session, a loop or a misconfigured price can cost.
// Calls that run on the user's Claude plan (provider "claude-code") cost no money and are not counted.
//
// One append-only file per local day under ~/.polywatch-spend/ (POLYWATCH_SPEND_DIR overrides it):
// small appends from concurrent workers do not clobber each other, and old days can simply be deleted.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const spendDir = () => process.env.POLYWATCH_SPEND_DIR || join(homedir(), '.polywatch-spend');
const today = (d = new Date()) => d.toLocaleDateString('en-CA');           // YYYY-MM-DD, local time
const dayFile = (day = today()) => join(spendDir(), `${day}.jsonl`);

export function spentToday(day = today()) {
  const p = dayFile(day);
  if (!existsSync(p)) return 0;
  let usd = 0;
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l) continue; try { usd += Number(JSON.parse(l).usd) || 0; } catch {} }
  return usd;
}

export function recordSpend({ usd, project, id }) {
  if (!(usd > 0)) return;
  mkdirSync(spendDir(), { recursive: true });
  appendFileSync(dayFile(), JSON.stringify({ at: new Date().toISOString(), usd, project, id }) + '\n');
}

// The cost notice is shown once per machine, at the first session polywatch sees.
export function firstRunNotice(cfg) {
  const marker = join(spendDir(), 'notice-shown');
  if (existsSync(marker)) return null;
  try { mkdirSync(spendDir(), { recursive: true }); writeFileSync(marker, new Date().toISOString()); } catch { return null; }
  const conf = cfg.adjudicator?.provider === 'claude-code' ? 'Confirmation runs on your Claude plan through claude -p.' : `Confirmation uses your ${cfg.adjudicator?.provider} API account.`;
  return `polywatch reviews each turn in the background using your own API accounts: typically $0.01 to $0.15 per reviewed turn. ${conf} `
    + `Caps: $${cfg.budgetUsdPerTurn.toFixed(2)} per turn and $${cfg.budgetUsdPerDay.toFixed(2)} per day across all projects ("budgetUsdPerTurn", "budgetUsdPerDay" in ~/.polywatch.json). `
    + 'Set spending limits with your providers as well. See spending with "polywatch stats" or the dashboard. This notice is shown once.';
}
