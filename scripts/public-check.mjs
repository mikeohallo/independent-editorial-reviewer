#!/usr/bin/env node
// Public-repo check: everything in this repository is public (see AGENTS.md).
// Fails if tracked files, commit messages or pull request / issue text contain
// account-specific values or any name from a private list.
//
//   node scripts/public-check.mjs                 tracked files (+ CHECK_RANGE commits, PR_TITLE, PR_BODY)
//   node scripts/public-check.mjs --text A,B      only the text in environment variables A and B
//
// PUBLIC_CHECK_TERMS: private names, one per line; a "cs:" prefix makes a term
// case-sensitive. Held as an encrypted CI secret, never in the repository.
// Hits are reported by place only, never by term. REQUIRE_TERMS=1 makes a
// missing list a failure (CI on this repository's own branches).
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const args = process.argv.slice(2);
const textOnly = args[0] === '--text' ? (args[1] || '').split(',').filter(Boolean) : null;

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const terms = (process.env.PUBLIC_CHECK_TERMS || '')
  .split(/\r?\n/).map(t => t.trim()).filter(Boolean)
  .map(t => t.startsWith('cs:')
    ? new RegExp(`(?<![A-Za-z0-9])${escape(t.slice(3))}(?![A-Za-z0-9])`)
    : new RegExp(`(?<![A-Za-z0-9])${escape(t)}(?![A-Za-z0-9])`, 'i'));

const ALLOWED_EMAIL = /@(users\.noreply\.github\.com|example\.(com|org|net))$|^noreply@anthropic\.com$/i;
const rules = [
  {name: 'a Google Drive ID-shaped string', re: /(?<![A-Za-z0-9_-])(?:1[A-Za-z0-9_-]{32,43}|0B[A-Za-z0-9_-]{26,38})(?![A-Za-z0-9_-])/g,
    keep: m => !/^[0-9a-f]+$/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m), skip: f => f === 'package-lock.json'},
  {name: 'a machine path', re: /(?<![A-Za-z0-9])[A-Za-z]:[\\/][A-Za-z0-9_.-]+|\/(?:Users|home)\/[A-Za-z0-9_.-]+/g,
    keep: () => true, skip: f => f === 'package-lock.json'},
  {name: 'a workers.dev subdomain', re: /[A-Za-z0-9-]+\.workers\.dev\b/g, keep: () => true},
  {name: 'an email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    keep: m => !ALLOWED_EMAIL.test(m), skip: f => f === 'package-lock.json'},
];

const hits = [];
function scan(label, text, file) {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const r of rules) {
      if (file && r.skip && r.skip(file)) continue;
      for (const m of line.matchAll(r.re)) if (r.keep(m[0])) hits.push({label, line: i + 1, file, what: r.name});
    }
    if (terms.some(t => t.test(line))) hits.push({label, line: i + 1, file, what: 'a name from the private list'});
  });
}

// This script names the shapes it looks for, so it is exempt from them.
const SELF = 'scripts/public-check.mjs';

if (textOnly) {
  for (const v of textOnly) scan(v, process.env[v] || '');
} else {
  const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
  for (const f of files) {
    const buf = readFileSync(f);
    if (buf.includes(0)) continue; // binary
    if (f === SELF) { if (terms.some(t => t.test(buf.toString('utf8')))) hits.push({label: f, line: 0, file: f, what: 'a name from the private list'}); continue; }
    scan(f, buf.toString('utf8'), f);
  }
  const range = process.env.CHECK_RANGE;
  if (range) {
    const log = execFileSync('git', ['log', '--format=%H%x00%B%x01', range], {encoding: 'utf8'});
    for (const entry of log.split('\x01')) {
      const [sha, body] = entry.trim().split('\0');
      if (sha && body !== undefined) scan(`commit ${sha.slice(0, 7)} message`, body);
    }
  }
  for (const v of ['PR_TITLE', 'PR_BODY']) if (process.env[v]) scan(`pull request ${v === 'PR_TITLE' ? 'title' : 'description'}`, process.env[v]);
}

if (!terms.length) {
  const msg = 'The private name list is not available here, so names were not checked (AGENTS.md section 1 still applies).';
  if (process.env.REQUIRE_TERMS === '1') { console.log(`::error::${msg} CI on this repository's own branches needs the PUBLIC_CHECK_TERMS secret.`); process.exitCode = 1; }
  else console.log(`::notice::${msg}`);
}

for (const h of hits) {
  const where = h.file ? `file=${h.file},line=${h.line}` : '';
  console.log(`::error ${where}::${h.label}, line ${h.line}: ${h.what}. Everything here is public; see AGENTS.md.`);
}
if (hits.length) process.exitCode = 1;
else console.log(`public-check: clean (${textOnly ? 'text' : 'files'}${terms.length ? ', with the private list' : ''}).`);
