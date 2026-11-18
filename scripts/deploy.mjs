#!/usr/bin/env node
// Deploy the Independent Editorial Reviewer: staging first, then production.
//
// Usage (from the root of a fresh clone switched to the named commit):
//   node scripts/deploy.mjs <40-character commit> --settings <file> [--with-migrations] [--report-dir <dir>]
//   node scripts/deploy.mjs <40-character commit> --settings <file> --rehearse   (not on Windows; stops before the login)
//
// The settings file lives on the deploy machine, outside every repo, and holds what
// this public repo doesn't: the four Drive folder IDs, the account's workers.dev
// subdomain, and the deploy machine's own folders. See docs/DEPLOY.md for its shape.
//
// Follows the owner's deploy design: every check before the login, installs and
// tests logged out, a clean install with no scripts, one short Wrangler login,
// staging then production with unpaid live checks, and a logout that always runs.
// Nothing here reads, prints or stores a secret value. No paid review is called.
// Node built-ins only.

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Resolver} from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

// ---------- fixed expectations (change these only in a reviewed commit) ----------

const PRODUCTION = 'claude-openai-reviewer';
const STAGING = 'claude-openai-reviewer-v5-staging';
const HOST = 'reviewer.mikeohalloran.au';
const KV_TITLE = 'reviewer-oauth';
const APPLIED_MIGRATION_TAGS = ['editorial-v5-1'];
const LOGIN_SCOPES = ['account:read', 'user:read', 'workers:write', 'workers_scripts:write', 'workers_kv:write', 'workers_routes:write', 'zone:read'];
const STAGING_SECRETS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_SCOPE', 'GOOGLE_REFRESH_TOKEN', 'MCP_ACCESS_TOKEN', 'OPENAI_API_KEY'];
const PRODUCTION_SECRETS = [...STAGING_SECRETS, 'ALLOWED_EMAIL'];

// The reviewer's settings, as reviewed (read live on both Workers, 18 Nov 2026).
// A change to a money cap, the model or Drive access must change this too, so it
// shows in review. The two Access values are checked by pattern. The four Drive
// folder IDs come from the settings file at deploy time; the live-settings check
// stops the deploy if they differ from what's live.
const COMMON_VARS = {
  EDITORIAL_MODEL: 'gpt-6.1-sol',
  EDITORIAL_REASONING_EFFORT: 'high',
  EDITORIAL_MAX_JOB_USD: '1',
  EDITORIAL_DAILY_USD: '1',
  WORKSPACE_ROOT_FOLDER_ID: 'SET-AT-DEPLOY',
  SUBMISSIONS_FOLDER_ID: 'SET-AT-DEPLOY',
  REFERENCES_FOLDER_ID: 'SET-AT-DEPLOY',
  EDITORIAL_FOLDER_ID: 'SET-AT-DEPLOY',
  DRIVE_ACCESS_MODE: 'full',
  BROAD_DRIVE_SCOPE_ACK: 'I_UNDERSTAND_FULL_DRIVE_ACCESS',
  PROJECT_CONTEXT_FILE_IDS: '',
};
const DO_BINDINGS = {bindings: [
  {name: 'EDITORIAL_JOBS', class_name: 'EditorialJob'},
  {name: 'EDITORIAL_BUDGET', class_name: 'EditorialBudget'},
]};
const ACCESS_PLACEHOLDER = 'SET-AFTER-ACCESS-APP';
const DRIVE_FOLDER_KEYS = ['WORKSPACE_ROOT_FOLDER_ID', 'SUBMISSIONS_FOLDER_ID', 'REFERENCES_FOLDER_ID', 'EDITORIAL_FOLDER_ID'];
const SETTINGS_KEYS = ['driveFolders', 'workersDevSubdomain', 'runsDir', 'noHooksDir'];
const EXPECTED_CONFIG = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: PRODUCTION,
  main: 'src/index.mjs',
  compatibility_date: '2026-11-17',
  keep_vars: true,
  workers_dev: false,
  preview_urls: false,
  routes: [{pattern: HOST, custom_domain: true}],
  kv_namespaces: [{binding: 'OAUTH_KV'}],
  durable_objects: DO_BINDINGS,
  migrations: [{tag: 'editorial-v5-1', new_sqlite_classes: ['EditorialJob', 'EditorialBudget']}],
  vars: {EDITORIAL_ENABLED: '1', ...COMMON_VARS, ACCESS_TEAM_DOMAIN: '(checked by pattern)', ACCESS_AUD: '(checked by pattern)'},
  env: {staging: {
    name: STAGING,
    workers_dev: false,
    preview_urls: false,
    routes: [],
    durable_objects: DO_BINDINGS,
    vars: {EDITORIAL_ENABLED: '0', ...COMMON_VARS},
  }},
};

// ---------- arguments ----------

const args = process.argv.slice(2);
const commit = args.find(a => /^[0-9a-f]{40}$/.test(a));
const rehearse = args.includes('--rehearse');
const withMigrations = args.includes('--with-migrations');
const isWindows = process.platform === 'win32';
const reportDirArg = args.includes('--report-dir') ? args[args.indexOf('--report-dir') + 1] : null;
const settingsArg = args.includes('--settings') ? args[args.indexOf('--settings') + 1] : null;
const known = new Set(['--rehearse', '--with-migrations', '--report-dir', reportDirArg, '--settings', settingsArg, commit]);
const unknown = args.filter(a => !known.has(a));

const repo = process.cwd();
const startedAt = new Date();
const log = [];
let loggedIn = false;
let failed = null;

function line(text) { console.log(text); log.push(text); }
function step(title) { line(''); line(`## ${title}`); }
function ok(text) { line(`- PASS: ${text}`); }
function note(text) { line(`- ${text}`); }
class Stop extends Error {}
function stop(text) { line(`- STOP: ${text}`); throw new Stop(text); }

// ---------- running things without the PC's settings ----------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-deploy-'));
const emptyGitConfig = path.join(scratch, 'empty-gitconfig');
const emptyUserNpmrc = path.join(scratch, 'empty-user-npmrc');
const emptyGlobalNpmrc = path.join(scratch, 'empty-global-npmrc');
for (const f of [emptyGitConfig, emptyUserNpmrc, emptyGlobalNpmrc]) fs.writeFileSync(f, '');
let noHooks = null; // set from the settings file on Windows; a fresh empty folder elsewhere
let settings = null;

function childEnv({git = false} = {}) {
  const env = {...process.env};
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODE_USE_SYSTEM_CA') delete env[k];
  if (git) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'GIT_ASKPASS') delete env[k];
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  }
  return env;
}

function run(file, argv, {env = childEnv(), capture = true, allowFail = false} = {}) {
  const r = spawnSync(file, argv, {cwd: repo, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false, maxBuffer: 64 * 1024 * 1024});
  if (r.error) { if (allowFail) return r; stop(`${path.basename(file)} could not start: ${r.error.message}`); }
  if (r.status !== 0 && !allowFail) {
    const tail = capture ? `\n${(r.stdout || '').slice(-1500)}\n${(r.stderr || '').slice(-1500)}` : '';
    stop(`${path.basename(file)} ${argv.slice(0, 3).join(' ')} exited ${r.status}${tail}`);
  }
  return r;
}

function git(argv, opts) {
  return run('git', ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.fsmonitor=false', ...argv], {env: childEnv({git: true}), ...opts});
}

function npmCli() {
  const dir = path.dirname(process.execPath);
  for (const p of [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (fs.existsSync(p)) return p;
  }
  stop(`Node's own npm not found beside ${process.execPath}`);
}

function npm(argv, opts) {
  return run(process.execPath, [npmCli(), `--userconfig=${emptyUserNpmrc}`, `--globalconfig=${emptyGlobalNpmrc}`, ...argv], opts);
}

const wranglerJs = path.join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
function wrangler(argv, opts) { return run(process.execPath, [wranglerJs, ...argv], opts); }

// ---------- 0. the settings file ----------

function loadSettings() {
  step('0. The settings file (outside the repo)');
  if (!settingsArg) stop('the line must name the settings file (--settings <file>); it holds the Drive folder IDs and this machine\'s folders');
  const file = path.resolve(settingsArg);
  if (file.startsWith(path.resolve(repo) + path.sep)) stop('the settings file is inside the clone; it must live outside every repo');
  if (!fs.existsSync(file)) stop(`the settings file ${file} doesn't exist`);
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { stop(`the settings file ${file} is not plain JSON`); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) stop('the settings file is not a JSON object');
  const keys = Object.keys(s).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...SETTINGS_KEYS].sort())) stop(`the settings file must hold exactly: ${SETTINGS_KEYS.join(', ')} (it holds: ${keys.join(', ') || 'nothing'})`);
  const d = s.driveFolders;
  if (!d || typeof d !== 'object' || JSON.stringify(Object.keys(d).sort()) !== JSON.stringify([...DRIVE_FOLDER_KEYS].sort())) stop(`driveFolders must hold exactly: ${DRIVE_FOLDER_KEYS.join(', ')}`);
  for (const k of DRIVE_FOLDER_KEYS) if (typeof d[k] !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(d[k])) stop(`driveFolders.${k} doesn't look like a Drive folder ID`);
  if (new Set(DRIVE_FOLDER_KEYS.map(k => d[k])).size !== 4) stop('the four Drive folder IDs must all differ');
  if (typeof s.workersDevSubdomain !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s.workersDevSubdomain)) stop('workersDevSubdomain must be the account\'s workers.dev subdomain (lower-case letters, digits, hyphens)');
  for (const k of ['runsDir', 'noHooksDir']) if (typeof s[k] !== 'string' || !path.isAbsolute(s[k])) stop(`${k} must be an absolute folder path`);
  settings = s;
  ok(`settings file ${file}: four Drive folder IDs, the workers.dev subdomain, the run-report and no-hooks folders.`);
  if (isWindows) {
    if (!fs.existsSync(s.noHooksDir) || !fs.statSync(s.noHooksDir).isDirectory()) stop(`the no-hooks folder ${s.noHooksDir} doesn't exist`);
    if (fs.readdirSync(s.noHooksDir).length) stop(`the no-hooks folder ${s.noHooksDir} isn't empty`);
    noHooks = s.noHooksDir;
    ok(`git runs with hooks pointed at the empty folder ${noHooks}.`);
  } else {
    noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'no-hooks-'));
    note(`not Windows: hooks point at a fresh empty folder (${noHooks}); the settings file's noHooksDir is for the PC.`);
  }
}

// The reviewed settings with the Drive folder IDs from the settings file filled in.
// Only ever written to the scratch deploy config, never to the clone.
function withLocalSettings(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const vars of [out.vars, out.env.staging.vars]) for (const k of DRIVE_FOLDER_KEYS) vars[k] = settings.driveFolders[k];
  const left = JSON.stringify(out).includes('SET-AT-DEPLOY');
  if (left) stop('a SET-AT-DEPLOY placeholder is left after filling in the settings file');
  return out;
}

// ---------- 1. the PC ----------

const BLOCKED_NAMES = [/^GIT_/, /^NODE_/, /^NPM_CONFIG_/, /^CLOUDFLARE_/, /^CF_/, /^WRANGLER_/, /^MINIFLARE_/, /^OPENSSL_/, /^XDG_CONFIG_HOME$/, /^PREFIX$/, /^DESTDIR$/, /_PROXY$/, /^CI$/];
const APP_FOUR = ['GIT_ASKPASS', 'GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'NODE_USE_SYSTEM_CA'];

function setInWindowsEnvironment(name) {
  const reg = 'C:\\Windows\\System32\\reg.exe';
  const keys = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];
  return keys.some(k => spawnSync(reg, ['query', k, '/v', name], {stdio: 'ignore', shell: false}).status === 0);
}

function checkPc() {
  step('1. The PC (names only, never values)');
  const hits = Object.keys(process.env).map(k => k.toUpperCase()).filter(k => BLOCKED_NAMES.some(rx => rx.test(k)));
  const appFour = hits.filter(k => APP_FOUR.includes(k));
  const others = hits.filter(k => !APP_FOUR.includes(k));
  if (isWindows) {
    for (const k of appFour) {
      const set = setInWindowsEnvironment(k);
      note(`${k} set in Windows' User or Machine environment: ${set}`);
      if (set) stop(`${k} is set in Windows' own environment, not only by the Claude app`);
    }
  }
  if (others.length) {
    if (rehearse && !isWindows) note(`would stop on the PC (rehearsal workspace only): ${others.join(', ')}`);
    else stop(`environment variables that change git, npm, Node or Wrangler are set: ${others.join(', ')}`);
  } else ok('no blocked environment variable names; nothing found.');

  if (isWindows) {
    const want = {COMSPEC: 'c:\\windows\\system32\\cmd.exe', SYSTEMROOT: 'c:\\windows', WINDIR: 'c:\\windows'};
    for (const [k, v] of Object.entries(want)) {
      const actual = Object.entries(process.env).find(([n]) => n.toUpperCase() === k)?.[1] || '';
      if (actual.toLowerCase() !== v) stop(`${k} does not point at C:\\Windows`);
    }
    ok('ComSpec, SystemRoot and windir point at C:\\Windows.');
  } else note('Windows folder check: Windows only, not run here.');

  const home = os.homedir();
  const appdata = process.env.APPDATA || '';
  const npmrcs = [path.join(home, '.npmrc')];
  const prefixes = [];
  if (isWindows && appdata) { prefixes.push(path.join(appdata, 'npm')); npmrcs.push(path.join(appdata, 'npm', 'etc', 'npmrc')); }
  for (let i = 0; i < npmrcs.length; i++) {
    const f = npmrcs[i];
    if (!fs.existsSync(f)) continue;
    const keys = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.split('=')[0].trim().toLowerCase()).filter(Boolean);
    if (keys.some(k => k === 'node-options' || k === 'script-shell')) stop(`${f} sets node-options or script-shell`);
    const prefixLine = fs.readFileSync(f, 'utf8').split(/\r?\n/).find(l => /^\s*prefix\s*=/.test(l));
    if (prefixLine) {
      const p = prefixLine.split('=').slice(1).join('=').trim();
      prefixes.push(p); npmrcs.push(path.join(p, 'etc', 'npmrc'));
    }
  }
  ok('npm settings files set no node-options or script-shell; nothing found.');
  for (const p of prefixes) {
    if (fs.existsSync(path.join(p, 'node_modules', 'npm'))) stop(`another npm is installed under ${p}`);
  }
  ok('no other npm where the npm command would find it; nothing found.');
}

// ---------- 2–3. the commit and the clone ----------

function checkCommit() {
  step('2. The commit');
  if (!commit) stop('the line must name the full 40-character commit');
  if (unknown.length) stop(`unknown arguments: ${unknown.join(' ')}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  if (pkg.name !== 'claude-openai-editorial-reviewer') stop('not run from the reviewer repo root');
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  if (head !== commit) stop(`HEAD is ${head}, not the named commit`);
  ok(`HEAD is ${commit}.`);
  const main = git(['rev-parse', 'origin/main']).stdout.trim();
  if (main !== commit) stop(`origin/main is ${main}, not the named commit`);
  ok('origin/main equals the named commit, all 40 characters.');
  const status = git(['status', '--porcelain']).stdout;
  if (status.trim()) stop(`the tree is not clean:\n${status}`);
  ok('git status --porcelain is empty.');
  const hooksCfg = run('git', ['config', '--show-origin', '--get-all', 'core.hooksPath'], {allowFail: true, env: childEnv()});
  if ((hooksCfg.stdout || '').trim()) stop(`a core.hooksPath setting exists: ${hooksCfg.stdout.trim()}`);
  const hooksDir = path.join(repo, '.git', 'hooks');
  const hookFiles = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).filter(f => !f.endsWith('.sample')) : [];
  if (hookFiles.length) stop(`.git/hooks holds: ${hookFiles.join(', ')}`);
  ok('no hooks setting and no hooks; nothing found.');
}

// ---------- 4. the app ----------

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function sameKeysInOrder(a, b) { return JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b)); }

function checkApp() {
  step('4. The app (settings guard)');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(repo, 'wrangler.jsonc'), 'utf8')); }
  catch { stop('wrangler.jsonc is not plain JSON (comments or a syntax error); the guard reads it exactly'); }
  const tags = (cfg.migrations || []).map(m => m.tag);
  const newTags = tags.filter(t => !APPLIED_MIGRATION_TAGS.includes(t));
  if (newTags.length && !withMigrations) stop(`new Durable Object migrations (${newTags.join(', ')}) need "with migrations" in the line`);
  if (!newTags.length && withMigrations) stop('the line says "with migrations" but there is no new migration');
  const access = {team: cfg.vars?.ACCESS_TEAM_DOMAIN, aud: cfg.vars?.ACCESS_AUD};
  const masked = JSON.parse(JSON.stringify(cfg));
  if (masked.vars) { masked.vars.ACCESS_TEAM_DOMAIN = '(checked by pattern)'; masked.vars.ACCESS_AUD = '(checked by pattern)'; }
  const {migrations: m1, ...rest} = masked;
  const {migrations: m2, ...expectedRest} = EXPECTED_CONFIG;
  if (!newTags.length && !deepEqual(m1, m2)) stop('the existing migrations changed');
  if (!deepEqual(rest, expectedRest) || !sameKeysInOrder(rest, expectedRest)) {
    const diff = [...new Set([...Object.keys(rest), ...Object.keys(expectedRest)])].filter(k => !deepEqual(rest[k], expectedRest[k]));
    stop(`wrangler.jsonc differs from the reviewed settings in: ${diff.join(', ') || 'key order'}`);
  }
  ok(`wrangler.jsonc equals the reviewed settings: Worker ${PRODUCTION} on ${HOST} only (workers.dev off), staging ${STAGING} with no address and editorial off, caps US$1 a job and US$1 a day, model gpt-6.1-sol, Drive mode full, Drive folders filled in at deploy.`);
  ok(`migrations: ${tags.join(', ')}${newTags.length ? ` (new: ${newTags.join(', ')}, allowed by the line)` : ' (already applied)'}.`);
  const accessReal = /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(access.team || '') && /^[0-9a-f]{64}$/.test(access.aud || '');
  if (!accessReal) {
    if (rehearse) note('Access values are still placeholders: the real line would stop here (the rehearsal carries on).');
    else stop('the Access team domain or application audience is still a placeholder: make the Access apps and commit their values first');
  } else ok(`Access values look real: team ${access.team}, audience ${access.aud.slice(0, 8)}…`);
  const version = (fs.readFileSync(path.join(repo, 'src', 'editorial.mjs'), 'utf8').match(/export const VERSION = '([^']+)'/) || [])[1];
  if (!version) stop('VERSION not found in src/editorial.mjs');
  note(`code version: ${version}`);
  return {version, cfg};
}

// ---------- 5 and 11. logins, without running Wrangler ----------

function loginRoots() {
  const home = os.homedir();
  if (isWindows) {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appdata, 'xdg.config', '.wrangler'), path.join(home, '.wrangler'), path.join(appdata, 'xdg.config', 'cloudflare')];
  }
  return [path.join(home, '.config', '.wrangler'), path.join(home, '.wrangler'), path.join(home, '.config', 'cloudflare'),
    path.join(home, 'Library', 'Preferences', '.wrangler')];
}

function findLogins() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      const rel = p.replace(/\\/g, '/');
      if (/\/cloudflare\//.test(rel)) found.push(p);
      else if (/\/config\/default\.toml$/.test(rel) && /^\s*(oauth_token|api_token)\s*=/m.test(fs.readFileSync(p, 'utf8'))) found.push(p);
      else if (/\/config\/default\.enc$/.test(rel)) found.push(p);
      else if (/\/profiles\//.test(rel)) found.push(p);
      else if (/temporary-account/i.test(e.name)) found.push(p);
    }
  };
  for (const r of loginRoots()) walk(r, 0);
  return found;
}

function checkNoLogin(when) {
  const found = findLogins();
  if (found.length) stop(`${when}: a Wrangler login is on this machine (${found.length} file(s) under ${[...new Set(found.map(f => path.dirname(f)))].join(', ')}). Another deploy may be running: ask the owner.`);
  ok(`${when}: no Wrangler login in any place Wrangler keeps one; nothing found.`);
}

// ---------- 6–8. install, test, clean install, leftovers ----------

function removeOwnOutput() {
  for (const d of ['.test-build', '.test-build-oauth']) fs.rmSync(path.join(repo, d), {recursive: true, force: true});
  const dotW = path.join(repo, '.wrangler');
  if (fs.existsSync(dotW)) {
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
    walk(dotW);
    if (files.length) stop(`.wrangler holds files: ${files.map(f => path.relative(repo, f)).join(', ')}`);
    fs.rmSync(dotW, {recursive: true, force: true});
  }
}

function installAndTest() {
  step('6. Install and test, logged out');
  npm(['ci', '--no-audit', '--no-fund']);
  ok('npm ci from the lockfile.');
  const unitFiles = fs.readdirSync(path.join(repo, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`);
  run(process.execPath, ['--test', ...unitFiles]);
  ok(`unit tests passed (${unitFiles.join(', ')}).`);
  wrangler(['deploy', '--dry-run', '--config', 'wrangler.jsonc', '--env=', '--outdir', '.test-build', 'test/runtime-entry/index.mjs']);
  wrangler(['deploy', '--dry-run', '--config', 'wrangler.jsonc', '--env=', '--outdir', '.test-build-oauth']);
  run(process.execPath, ['--test', 'test/runtime.mjs', 'test/oauth.runtime.mjs']);
  ok('runtime tests passed: the reviewer, and the login end to end (dry-run builds, no login).');
  removeOwnOutput();

  step('7. Clean install, no scripts');
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  fs.rmSync(path.join(repo, 'node_modules', '.cache'), {recursive: true, force: true});
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const want = lock.packages?.['node_modules/wrangler']?.version;
  const have = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', 'wrangler', 'package.json'), 'utf8')).version;
  if (!want || want !== have) stop(`installed Wrangler ${have} is not the lockfile's ${want}`);
  ok(`npm ci --ignore-scripts; Wrangler's cache deleted; Wrangler ${have} is the lockfile's.`);
  const out = path.join(scratch, 'bundle');
  wrangler(['deploy', '--dry-run', '--config', 'wrangler.jsonc', '--env=', '--outdir', out]);
  const bundle = path.join(out, 'index.js');
  if (!fs.existsSync(bundle)) stop('the dry-run build produced no index.js');
  const hash = createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
  ok(`the Worker builds from the clean install; bundle sha256 ${hash}.`);
  removeOwnOutput();

  step('8. Leftovers');
  const ignored = git(['status', '--porcelain', '--ignored']).stdout.split(/\r?\n/).filter(Boolean);
  const extra = ignored.filter(l => l !== '!! node_modules/');
  if (extra.length) stop(`files git doesn't track are here: ${extra.join(', ')}`);
  for (const f of fs.readdirSync(repo)) if (/^\.env/.test(f) || f === '.dev.vars') stop(`${f} is here`);
  ok('only node_modules/ is untracked; no .env, .dev.vars or .wrangler; nothing found.');
  return {wranglerVersion: have, bundleHash: hash};
}

// ---------- 9. scopes and login ----------

function checkScopes() {
  step('9. Login scopes');
  const list = wrangler(['login', '--scopes-list']).stdout || '';
  const missing = LOGIN_SCOPES.filter(s => !list.includes(s));
  if (missing.length) stop(`Wrangler doesn't know these scopes: ${missing.join(', ')}`);
  ok(`Wrangler knows every scope asked for: ${LOGIN_SCOPES.join(' ')}.`);
}

function login() {
  note(`Logging in. Cloudflare's Allow page should list only: ${LOGIN_SCOPES.join(', ')} (plus offline access, which Wrangler always adds).`);
  loggedIn = true;
  wrangler(['login', '--scopes', ...LOGIN_SCOPES], {capture: false});
  ok('logged in.');
}

// ---------- 10. deploy and live checks ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch through Cloudflare's public resolver, so a new hostname works even when
// this PC's own DNS cache hasn't caught up yet (Drover's first live check).
const resolver = new Resolver(); resolver.setServers(['1.1.1.1', '1.0.0.1']);
function get(url, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({hostname: u.hostname, path: u.pathname + u.search, method, headers: {'User-Agent': 'reviewer-deploy-check', ...headers},
      lookup: (host, opts, cb) => resolver.resolve4(host, (err, addrs) => {
        if (err || !addrs.length) return cb(err || new Error('no address'));
        if (opts && opts.all) return cb(null, addrs.map(a => ({address: a, family: 4})));
        return cb(null, addrs[0], 4);
      }), timeout: 15000}, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; }); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: data}));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function retry(what, fn, tries = 24) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; } await sleep(5000); }
  stop(`${what}: ${last?.message || last}`);
}

function liveVersion(name, env) {
  const depOut = wrangler(['deployments', 'list', '--config', deployConfig, `--env=${env}`, '--json']).stdout;
  const deps = JSON.parse(depOut.slice(depOut.search(/[[{]/)));
  const list = Array.isArray(deps) ? deps : (deps.deployments || []);
  const latest = list.slice().sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0];
  const live = (latest?.versions || []).filter(v => v.percentage === 100);
  if (live.length !== 1) stop(`${name}'s newest deployment doesn't send all traffic to one version: ${JSON.stringify(latest?.versions)}`);
  const versionId = live[0].version_id;
  const viewOut = wrangler(['versions', 'view', versionId, '--config', deployConfig, `--env=${env}`, '--json']).stdout;
  const view = JSON.parse(viewOut.slice(viewOut.indexOf('{')));
  const bindings = view?.resources?.bindings;
  if (!Array.isArray(bindings)) stop(`${name}'s live version ${versionId} shows no bindings to compare`);
  return {deploymentId: latest.id, versionId, view, bindings};
}

// Instead of Wrangler's --strict (which refuses every deploy after a secret is typed in
// the dashboard, the owner's own route for secrets): compare the live version's settings
// with the reviewed ones. A variable changed in the dashboard stops the deploy; secrets
// are checked by name only.
const INTENDED_CHANGES = {staging: {EDITORIAL_ENABLED: '0'}}; // step 2 turns staging's editorial off
function checkLiveSettings(name, env, localVars, secrets) {
  const live = liveVersion(name, env);
  const remoteVars = Object.fromEntries(live.bindings.filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
  const remoteSecrets = live.bindings.filter(b => b.type === 'secret_text').map(b => b.name).sort();
  const intended = INTENDED_CHANGES[env || 'production'] || {};
  const changed = Object.keys(remoteVars).filter(k => k in localVars ? remoteVars[k] !== localVars[k] && intended[k] !== localVars[k] : true);
  if (changed.length) stop(`${name}'s live settings differ from the reviewed ones in: ${changed.join(', ')} (changed in the dashboard?). Nothing deployed to it.`);
  const added = Object.keys(localVars).filter(k => !(k in remoteVars));
  const flipped = Object.keys(intended).filter(k => remoteVars[k] !== undefined && remoteVars[k] !== localVars[k]);
  ok(`${name}'s live settings match the reviewed ones${added.length ? `; adding ${added.join(', ')}` : ''}${flipped.length ? `; changing ${flipped.join(', ')} as planned` : ''}.`);
  const missing = secrets.filter(n => !remoteSecrets.includes(n));
  if (missing.length) stop(`${name} is missing secrets: ${missing.join(', ')}${missing.includes('ALLOWED_EMAIL') ? ' (ALLOWED_EMAIL is typed by the owner in the dashboard before the line)' : ''}`);
  ok(`${name} secrets present by name: ${secrets.join(', ')}.`);
}

function checkVersionMessage(name, env) {
  const {deploymentId, versionId, view} = liveVersion(name, env);
  const message = view.annotations?.['workers/message'];
  if (message !== `reviewer ${commit}`) stop(`${name}'s live version ${versionId} has message "${message}", not "reviewer ${commit}"`);
  ok(`${name}'s live version ${versionId} (deployment ${deploymentId}) carries the message "reviewer ${commit}".`);
  return {deployment: deploymentId, versions: versionId};
}

async function noWorkersDev(name) {
  const url = `https://${name}.${settings.workersDevSubdomain}.workers.dev/health`;
  // Cloudflare can take a little while to stop serving the old address.
  for (let i = 0; i < 24; i++) {
    let r = null;
    try { r = await get(url); } catch { ok(`${name}: no workers.dev address answers.`); return; }
    if (!r.text.includes('"service":"claude-openai-reviewer"')) { ok(`${name}: workers.dev address no longer serves the reviewer (status ${r.status}).`); return; }
    await sleep(5000);
  }
  stop(`${name} still answers on its workers.dev address`);
}

let deployConfig = path.join(repo, 'wrangler.jsonc');
let reviewedCfg = null;

function prepareDeployConfig(cfg) {
  step('9a. OAuth storage');
  // Run from an empty folder so Wrangler can't write the namespace into the clone's config.
  const kvDir = fs.mkdtempSync(path.join(scratch, 'kv-'));
  const listOut = wrangler(['kv', 'namespace', 'list', '--cwd', kvDir]).stdout;
  let spaces = JSON.parse(listOut.slice(listOut.indexOf('[')));
  let space = spaces.find(n => n.title === KV_TITLE);
  if (!space) {
    wrangler(['kv', 'namespace', 'create', KV_TITLE, '--cwd', kvDir, '--update-config=false']);
    const again = wrangler(['kv', 'namespace', 'list', '--cwd', kvDir]).stdout;
    spaces = JSON.parse(again.slice(again.indexOf('[')));
    space = spaces.find(n => n.title === KV_TITLE);
    if (!space) stop(`KV namespace ${KV_TITLE} could not be created`);
    ok(`KV namespace ${KV_TITLE} created (${space.id}).`);
  } else ok(`KV namespace ${KV_TITLE} found (${space.id}).`);
  reviewedCfg = cfg;
  const deployCfg = JSON.parse(JSON.stringify(cfg));
  delete deployCfg.$schema;
  deployCfg.main = path.join(repo, 'src', 'index.mjs');
  deployCfg.kv_namespaces = [{binding: 'OAUTH_KV', id: space.id}];
  deployConfig = path.join(scratch, 'wrangler.deploy.json');
  fs.writeFileSync(deployConfig, JSON.stringify(deployCfg, null, 2));
  ok('deploy settings written outside the clone: the reviewed settings plus the namespace id.');
}

async function deployStaging(version) {
  step(`10b. Deploy ${STAGING} (no address, editorial off)`);
  wrangler(['deploy', '--config', deployConfig, '--env=staging', '--message', `reviewer ${commit}`], {capture: false});
  ok(`${STAGING} deployed.`);
  await noWorkersDev(STAGING);
  return checkVersionMessage(STAGING, 'staging');
}

async function deployProduction(version) {
  step(`10c. Deploy ${PRODUCTION} on ${HOST}`);
  wrangler(['deploy', '--config', deployConfig, '--env=', '--message', `reviewer ${commit}`], {capture: false});
  ok(`${PRODUCTION} deployed.`);
  const base = `https://${HOST}`;
  const health = await retry(`${HOST}/health`, async () => {
    const r = await get(`${base}/health`); const j = JSON.parse(r.text);
    if (j.status !== 'online' || j.version !== version) throw new Error(`not yet: ${r.status} ${r.text.slice(0, 120)}`);
    return j;
  });
  if (health.editorial_enabled !== true || health.legacy_engine !== '4.1.0') stop(`${HOST}/health: ${JSON.stringify(health)}`);
  ok(`${HOST}/health: online, ${version}, editorial on, legacy 4.1.0.`);
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'});
  const bare = await get(`${base}/mcp`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
  if (bare.status !== 401 || !String(bare.headers['www-authenticate'] || '').includes('resource_metadata')) stop(`${HOST}/mcp with no token answered ${bare.status}, not 401 with a resource_metadata challenge (an Access path may be wrong)`);
  ok(`${HOST}/mcp with no token: 401 with the OAuth challenge.`);
  const asm = await get(`${base}/.well-known/oauth-authorization-server`);
  let meta = {}; try { meta = JSON.parse(asm.text); } catch {}
  if (asm.status !== 200 || meta.authorization_endpoint !== `${base}/authorize`) stop(`${HOST} OAuth metadata answered ${asm.status}`);
  ok(`${HOST} OAuth metadata answers, sign-in at ${base}/authorize.`);
  const authz = await get(`${base}/authorize?response_type=code`);
  const loc = String(authz.headers.location || '');
  if (![301, 302, 303, 307].includes(authz.status) || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//.test(loc)) stop(`${HOST}/authorize answered ${authz.status} without sending to Access (${loc.slice(0, 80)})`);
  ok(`${HOST}/authorize sends to Cloudflare Access.`);
  const other = await get(`${base}/nothing-here`);
  if (![302, 404].includes(other.status)) stop(`${HOST}/nothing-here answered ${other.status}`);
  ok(`${HOST}: other paths are behind Access or not found (${other.status}).`);
  await noWorkersDev(PRODUCTION);
  return checkVersionMessage(PRODUCTION, '');
}

// ---------- 11. logout, always ----------

function logout() {
  step('11. Logout');
  if (!loggedIn) { note('never logged in.'); return; }
  wrangler(['logout'], {allowFail: true, capture: false});
  for (const root of loginRoots()) {
    const profiles = path.join(root, 'profiles');
    if (!fs.existsSync(profiles)) continue;
    for (const f of fs.readdirSync(profiles)) {
      const name = f.replace(/\.[^.]+$/, '');
      if (name && name !== 'directory-bindings') wrangler(['auth', 'delete', name], {allowFail: true, capture: false});
    }
  }
  const left = findLogins();
  if (left.length) {
    line(`- STOP: a login file is still here after logout (${left.length}). The owner revokes Wrangler at https://dash.cloudflare.com/?to=/profile/access-management/authorization once he has said no deploy is running in any chat.`);
    failed = failed || 'login file left after logout';
  } else ok('logged out; no login file in any place Wrangler keeps one; nothing found.');
}

// ---------- the run ----------

function writeReport(summary) {
  // Without a readable settings file, the report goes beside the clone, in the deploy folder.
  const dir = reportDirArg || settings?.runsDir || path.resolve(repo, '..', 'reviewer-runs');
  fs.mkdirSync(dir, {recursive: true});
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const file = path.join(dir, `${stamp}-${(commit || 'nocommit').slice(0, 12)}-${rehearse ? 'rehearsal' : 'deploy'}.md`);
  const head = [
    `# Reviewer ${rehearse ? 'rehearsal' : 'deploy'}: ${failed ? 'FAILED' : 'PASSED'}`,
    '',
    `- Commit: ${commit || '(none)'}`,
    `- Started: ${startedAt.toISOString()} · finished ${new Date().toISOString()}`,
    `- Machine: ${process.platform}, Node ${process.version}`,
    ...summary.map(s => `- ${s}`),
    failed ? `- Stopped at: ${failed}` : '',
  ];
  fs.writeFileSync(file, [...head, ...log].join('\n') + '\n');
  console.log(`\nReport: ${file}`);
}

const summary = [];
try {
  line(`# Reviewer ${rehearse ? 'rehearsal' : 'deploy'} at ${commit || '(no commit)'}`);
  if (rehearse && isWindows) stop('--rehearse is for the workspace, not the PC');
  loadSettings();
  checkPc();
  checkCommit();
  const {version, cfg} = checkApp();
  step('5. Login check, before anything runs');
  checkNoLogin('before install');
  const built = installAndTest();
  summary.push(`Wrangler ${built.wranglerVersion}; bundle sha256 ${built.bundleHash}`);
  checkScopes();
  checkNoLogin('just before the login');
  if (rehearse) {
    step('Rehearsal ends here');
    withLocalSettings(cfg);
    ok('the settings file fills every SET-AT-DEPLOY placeholder (the filled settings are kept in memory only).');
    note('Not run in the rehearsal: the Windows checks, the login, the OAuth storage, both deploys, the live checks and the logout.');
  } else {
    const full = withLocalSettings(cfg);
    login();
    prepareDeployConfig(full);
    step('10a. Live settings, both Workers, before anything is deployed');
    checkLiveSettings(STAGING, 'staging', full.env.staging.vars, STAGING_SECRETS);
    checkLiveSettings(PRODUCTION, '', full.vars, PRODUCTION_SECRETS);
    const s = await deployStaging(version);
    summary.push(`Staging ${STAGING}: deployment ${s.deployment}, version ${s.versions}`);
    const p = await deployProduction(version);
    summary.push(`Production ${PRODUCTION} on ${HOST}: deployment ${p.deployment}, version ${p.versions}`);
  }
} catch (e) {
  failed = e instanceof Stop ? e.message.split('\n')[0] : `unexpected error: ${e.message}`;
  if (!(e instanceof Stop)) line(`- STOP: ${failed}`);
} finally {
  if (!rehearse) logout();
  fs.rmSync(scratch, {recursive: true, force: true});
  writeReport(summary);
  process.exitCode = failed ? 1 : 0;
}
