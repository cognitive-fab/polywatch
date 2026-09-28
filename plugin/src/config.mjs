// Configuration: defaults, then the user's ~/.polywatch.json, then <project>/.polywatch.json.
// A project file comes with the repository, so it may not choose where API keys are sent or which
// shell command runs: those keys are taken only from the user file, or from a project the user file
// lists under "trustedProjects".
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULTS = {
  reviewer: { provider: 'deepseek', model: 'deepseek-flash' },
  adjudicator: { provider: 'anthropic', model: 'claude-opus-5-5', maxClaims: 2, includeRequest: 'short' },
  testCommand: null,            // e.g. "npm test"; run for HARD changes when set
  testTimeoutSec: 300,
  budgetUsdPerTurn: 0.50,       // hard stop for reviewer + adjudicator spend per turn
  budgetUsdPerDay: 5,           // hard stop for money spent per local day, across all projects (plan calls not counted)
  maxFileBytes: 60000,          // per file sent to a reviewer
  maxFixRounds: 2,              // consecutive turns in which issues are sent back to Claude
  exclude: ['.env', '.env.*', '*.pem', '*.key', '*secret*', '*credential*', 'node_modules/**', '.git/**', '.polywatch/**'],
  minChangedLines: 3,           // smaller turns are logged but not reviewed
  reviewOutsideProject: false,  // review files written outside the project folder (e.g. Claude's scratchpad)
  confirm: 'top',               // which candidates the adjudicator checks, most severe first up to maxClaims: 'top' (high+medium) | 'high' | 'all' | 'none'
  maxFindings: 2,               // findings shown per turn, best first
  deliver: 'prompt',            // 'prompt': results arrive with the next prompt; 'stop': review before Claude stops and make it fix confirmed defects (slower turns; for headless runs)
  maxToClaude: 5,               // confirmed findings sent to Claude per turn, best first (may exceed maxFindings)
  minScore: 0.25,               // hide findings whose kind has been real less often than this
};

// Where each provider's key is read from and sent to, unless the user file says otherwise.
export const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
  'claude-code': {},            // runs `claude -p` on the user's Claude plan; no key
};

// Keys a project file may set only when the user trusts the project.
const SENSITIVE = [['testCommand'], ['reviewer', 'baseUrl'], ['reviewer', 'apiKeyEnv'], ['reviewer', 'price'], ['adjudicator', 'baseUrl'], ['adjudicator', 'apiKeyEnv'], ['adjudicator', 'price']];

// Arrays replace, except `exclude`, which only ever adds patterns to the defaults.
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (k === 'exclude' && Array.isArray(v)) out[k] = [...new Set([...(a[k] || []), ...v])];
    else out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  }
  return out;
}

function readConfigFile(p, warnings) {
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    warnings.push(`${p} is not a JSON object; ignored.`);
  } catch (e) { warnings.push(`${p} is not valid JSON (${e.message}); ignored.`); }
  return {};
}

export const userConfigPath = () => process.env.POLYWATCH_USER_CONFIG || join(homedir(), '.polywatch.json');
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function loadConfig(cwd) {
  const warnings = [];
  const user = readConfigFile(userConfigPath(), warnings);
  const project = readConfigFile(join(cwd, '.polywatch.json'), warnings);
  const trusted = Array.isArray(user.trustedProjects) && user.trustedProjects.some(p => typeof p === 'string' && samePath(p, cwd));
  if (!trusted) {
    const dropped = [];
    for (const path of SENSITIVE) {
      const parent = path.length === 1 ? project : project[path[0]];
      const key = path[path.length - 1];
      if (parent && typeof parent === 'object' && key in parent) {
        if (parent[key] !== null) dropped.push(path.join('.'));
        delete parent[key];
      }
    }
    if (dropped.length) warnings.push(`.polywatch.json settings ignored because this project is not trusted: ${dropped.join(', ')}. Set them in ${userConfigPath()}, or add this project to "trustedProjects" there.`);
  }
  const base = merge(structuredClone(DEFAULTS), user);   // clone: filled in below, DEFAULTS must stay untouched
  // A cloned repository may lower the spending caps but never raise them.
  if (!trusted) for (const k of ['budgetUsdPerTurn', 'budgetUsdPerDay']) {
    if (typeof project[k] === 'number' && project[k] > base[k]) { warnings.push(`.polywatch.json asks for ${k} ${project[k]}, above your ${base[k]}; kept at ${base[k]} (only your own settings can raise a cap).`); delete project[k]; }
  }
  const cfg = merge(base, project);
  // Per-provider key variables and endpoints; the user file's "providers" overrides the built-in ones.
  const providers = merge(PROVIDERS, user.providers && typeof user.providers === 'object' ? user.providers : {});
  for (const role of ['reviewer', 'adjudicator']) {
    const r = cfg[role], p = providers[r.provider] || {};
    // An untrusted project that switches provider must not inherit an endpoint or key set for another one.
    if (!trusted && r.provider !== base[role].provider) { delete r.baseUrl; delete r.apiKeyEnv; delete r.price; }
    r.baseUrl ??= p.baseUrl;
    r.apiKeyEnv ??= p.apiKeyEnv;
    if (r.price != null && !(Array.isArray(r.price) && r.price.length === 2 && r.price.every(x => typeof x === 'number' && x >= 0))) {
      warnings.push(`${role}.price must be [input, output] in USD per million tokens; ignored.`);
      delete r.price;
    }
  }
  delete cfg.trustedProjects; delete cfg.providers;
  cfg.onlyUnder = Array.isArray(user.onlyUnder) ? user.onlyUnder.filter(x => typeof x === 'string') : null;   // user file only
  cfg.warnings = warnings;
  return cfg;
}

// With "onlyUnder" in the user file, polywatch acts only in projects inside those folders.
export function inScope(cfg, cwd) {
  if (!cfg.onlyUnder) return true;
  const fold = (x) => process.platform === 'win32' ? resolve(x).toLowerCase() : resolve(x);
  return cfg.onlyUnder.some(root => { const rel = relative(fold(root), fold(cwd)); return !rel.startsWith('..') && !isAbsolute(rel); });
}

// The project a hook or command belongs to. Claude's shell moves between folders during a session and
// hooks receive that folder as cwd, so state kept there splits across subfolders and loses edits.
// Claude Code gives hooks the project folder; otherwise use the nearest folder with .git, else start.
export function projectRoot(start) {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return resolve(start);
  }
}

export function stateDir(cwd) {
  const d = join(cwd, '.polywatch');
  for (const sub of ['', 'turns', 'jobs', 'results', 'inbox']) mkdirSync(join(d, sub), { recursive: true });
  // The state holds prompts, file contents and review output: keep it out of commits.
  const gi = join(d, '.gitignore');
  if (!existsSync(gi)) { try { writeFileSync(gi, '*\n'); } catch {} }
  return d;
}
