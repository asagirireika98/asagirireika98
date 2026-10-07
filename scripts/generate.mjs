#!/usr/bin/env node
/**
 * Generates assets/profile.svg (terminal-style GitHub profile card)
 * from profile.config.json + live GitHub data.
 *
 *   node scripts/generate.mjs                 # live data (needs GH_TOKEN / GITHUB_TOKEN)
 *   node scripts/generate.mjs --mock          # fake data, for previewing the layout offline
 *   node scripts/generate.mjs --config other.json --out out.svg
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';

/* ───────────────────────── CLI + config ───────────────────────── */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const cfgPath = resolve(opt('config', 'profile.config.json'));
const baseDir = dirname(cfgPath);
const raw = JSON.parse(await readFile(cfgPath, 'utf8'));

const cfg = {
  host: 'github',
  output: 'assets/profile.svg',
  fields: [],
  skills: [],
  stats: ['contributions', 'commits', 'repos', 'prs', 'stars', 'issues', 'joined', 'contributedRepos'],
  chipsMaxChars: 38,
  ...raw,
  commands: {
    intro: 'cat /etc/profile.d/{name}',
    stats: './profile --stats --since=1y',
    languages: './profile --languages-by-commit',
    ascii: 'chafa {file}',
    ...raw.commands,
  },
  labels: {
    fields: 'profile.d',
    skills: 'languages',
    stats: 'metrics / 1y',
    activity: 'activity / 365d',
    languages: 'languages / commit',
    ...raw.labels,
  },
  languages: { max: 5, exclude: [], colors: {}, ...raw.languages },
  ascii: { enabled: false, cols: 80, maxFrames: 24, speed: 1, invert: false, ...raw.ascii },
  footer: { enabled: true, prompt: true, timestamp: true, timezone: 'UTC', ...raw.footer },
};
if (!cfg.username) throw new Error('profile.config.json: "username" is required');

const login = cfg.username;
const displayName = cfg.displayName || login;
const promptUser = cfg.promptUser || login;
const outPath = resolve(opt('out', resolve(baseDir, cfg.output)));

/* ───────────────────────── GitHub data ───────────────────────── */

const Q_MAIN = `
query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    createdAt
    followers{totalCount}
    repositories(first:100,ownerAffiliation:OWNER,privacy:PUBLIC){
      totalCount
      pageInfo{hasNextPage endCursor}
      nodes{stargazerCount}
    }
    contributionsCollection(from:$from,to:$to){
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      totalRepositoriesWithContributedCommits
      contributionCalendar{
        totalContributions
        weeks{contributionDays{date contributionCount}}
      }
      commitContributionsByRepository(maxRepositories:100){
        repository{primaryLanguage{name color}}
        contributions{totalCount}
      }
    }
  }
}`;

const Q_REPOS = `
query($login:String!,$after:String){
  user(login:$login){
    repositories(first:100,after:$after,ownerAffiliation:OWNER,privacy:PUBLIC){
      pageInfo{hasNextPage endCursor}
      nodes{stargazerCount}
    }
  }
}`;

async function gql(query, variables, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-svg-generator',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GitHub GraphQL error: ${res.status} ${JSON.stringify(json.errors ?? json.message)}`);
  }
  return json.data;
}

async function fetchData() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GH_TOKEN or GITHUB_TOKEN (or run with --mock).');

  const to = new Date();
  const from = new Date(to.getTime() - 365 * 864e5);
  const { user } = await gql(Q_MAIN, { login, from: from.toISOString(), to: to.toISOString() }, token);
  if (!user) throw new Error(`User "${login}" not found`);

  let stars = user.repositories.nodes.reduce((a, r) => a + r.stargazerCount, 0);
  let page = user.repositories.pageInfo;
  while (page.hasNextPage) {
    const d = await gql(Q_REPOS, { login, after: page.endCursor }, token);
    stars += d.user.repositories.nodes.reduce((a, r) => a + r.stargazerCount, 0);
    page = d.user.repositories.pageInfo;
  }

  const cc = user.contributionsCollection;
  const langMap = new Map();
  for (const e of cc.commitContributionsByRepository) {
    const l = e.repository.primaryLanguage;
    if (!l) continue;
    const cur = langMap.get(l.name) ?? { name: l.name, color: l.color, count: 0 };
    cur.count += e.contributions.totalCount;
    langMap.set(l.name, cur);
  }

  return {
    joined: new Date(user.createdAt).getUTCFullYear(),
    followers: user.followers.totalCount,
    repos: user.repositories.totalCount,
    stars,
    contributions: cc.contributionCalendar.totalContributions,
    commits: cc.totalCommitContributions,
    prs: cc.totalPullRequestContributions,
    reviews: cc.totalPullRequestReviewContributions,
    issues: cc.totalIssueContributions,
    contributedRepos: cc.totalRepositoriesWithContributedCommits,
    weeks: cc.contributionCalendar.weeks.map((w) => ({
      start: w.contributionDays[0].date,
      total: w.contributionDays.reduce((a, d) => a + d.contributionCount, 0),
    })),
    languages: [...langMap.values()],
  };
}

function mockData() {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const weeks = [];
  const start = new Date(Date.now() - 52 * 7 * 864e5);
  for (let i = 0; i < 53; i++) {
    const d = new Date(start.getTime() + i * 7 * 864e5);
    weeks.push({ start: d.toISOString().slice(0, 10), total: Math.round(rnd() ** 2 * 60) });
  }
  return {
    joined: 2021, followers: 12, repos: 18, stars: 41, contributions: 812, commits: 740, prs: 14,
    reviews: 3, issues: 5, contributedRepos: 9, weeks,
    languages: [
      { name: 'TypeScript', color: '#3178c6', count: 40 }, { name: 'Python', color: '#3572A5', count: 28 },
      { name: 'JavaScript', color: '#f1e05a', count: 17 }, { name: 'Vue', color: '#41b883', count: 9 },
      { name: 'Shell', color: '#89e051', count: 4 },
    ],
  };
}

/* ───────────────────────── helpers ───────────────────────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => Number(n).toLocaleString('en-US');
const THEME = new Set(['text', 'muted', 'green', 'blue', 'cyan', 'yellow', 'magenta']);
const col = (c) => (!c ? 'var(--text)' : THEME.has(c) ? `var(--${c})` : c);

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', Go: '#00ADD8',
  Vue: '#41b883', Astro: '#ff5a03', PHP: '#4F5D95', Svelte: '#ff3e00', CSS: '#663399', HTML: '#e34c26',
  Shell: '#89e051', Rust: '#dea584', 'C#': '#178600', 'C++': '#f34b7d', C: '#555555', Kotlin: '#A97BFF',
  Swift: '#F05138', Ruby: '#701516', Lua: '#000080', Luau: '#00A2FF', Dart: '#00B4AB', 'Node.js': '#539e43',
  SCSS: '#c6538c', Jupyter: '#DA5B0B', 'Jupyter Notebook': '#DA5B0B', GDScript: '#355570', Dockerfile: '#384d54',
};
const hashColor = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 55%)`;
};
const langColor = (name, apiColor) => cfg.languages.colors?.[name] || LANG_COLORS[name] || apiColor || hashColor(name);

const STAT_DEFS = {
  contributions: 'contributions',
  commits: 'commits / 1y',
  repos: 'public repos',
  prs: 'pull requests / 1y',
  stars: 'stars',
  issues: 'issues / 1y',
  joined: 'joined GitHub',
  contributedRepos: 'contributed repos / 1y',
  followers: 'followers',
  reviews: 'reviews / 1y',
};

const prompt = (y, cmd) =>
  `<text x="18" y="${y}" class="body"><tspan fill="var(--green)">${esc(promptUser)}@${esc(cfg.host)}</tspan>` +
  `<tspan fill="var(--text)">:</tspan><tspan fill="var(--blue)">~</tspan>` +
  `<tspan fill="var(--text)">$ ${esc(cmd)}</tspan></text>`;

/** Rounded-corner-free box whose top edge is interrupted by title labels. */
function box({ x0, y0, x1, y1, titles = [], dividers = [] }) {
  let d = '';
  let cur = x0;
  for (const t of titles) {
    d += `M ${cur} ${y0} H ${t.x - 6} `;
    cur = t.x + t.text.length * 6.6 + 8;
  }
  d += `M ${cur} ${y0} H ${x1} V ${y1} H ${x0} V ${y0}`;
  for (const dv of dividers) d += ` M ${dv} ${y0} V ${y1}`;
  const label = titles
    .map((t) => `<text x="${t.x}" y="${y0 + 4}" class="utility" fill="${col(t.color)}">${esc(t.text)}</text>`)
    .join('');
  return (
    `<path d="${d}" stroke="var(--muted)" stroke-opacity="0.36" stroke-width="1" fill="none" shape-rendering="crispEdges" />` +
    label
  );
}

/* ───────────────────────── ASCII animation (optional) ───────────────────────── */

async function buildAscii(a) {
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.warn('ascii: "sharp" is not installed (npm install) – skipping ASCII animation.');
    return null;
  }
  if (!a.source) {
    console.warn('ascii.enabled is true but ascii.source is missing – skipping.');
    return null;
  }
  const src = resolve(baseDir, a.source);
  const meta = await sharp(src, { animated: true }).metadata();
  const pages = meta.pages || 1;
  const pageH = meta.pageHeight || meta.height;
  const delays = meta.delay?.length ? meta.delay.map((d) => (d < 20 ? 100 : d)) : Array(pages).fill(100);

  const cols = a.cols;
  const rows = Math.max(1, Math.round(cols * 0.6 * (pageH / meta.width))); // cell is 6×10 units
  const step = Math.max(1, Math.ceil(pages / a.maxFrames));
  const ramp = a.charset || '.:-=+*#%@';
  const q = (v) => Math.round(v / 85) * 85;
  const hex = (r, g, b) => '#' + [r, g, b].map((v) => q(v).toString(16).padStart(2, '0')).join('');

  const frames = [];
  const durations = [];
  for (let p = 0; p < pages; p += step) {
    const { data } = await sharp(src, { page: p })
      .resize(cols, rows, { fit: 'fill', kernel: 'lanczos3' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const groups = new Map();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        if (data[i + 3] < 80) continue;
        const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        const dens = a.invert ? 1 - lum : lum;
        const ch = ramp[Math.min(ramp.length - 1, Math.floor(dens * ramp.length))];
        const key = hex(data[i], data[i + 1], data[i + 2]);
        const g = groups.get(key) ?? { xs: [], ys: [], chars: '' };
        g.xs.push(c * 6);
        g.ys.push(r * 10 + 8);
        g.chars += ch;
        groups.set(key, g);
      }
    }
    frames.push(
      [...groups]
        .map(([k, g]) => `<text fill="${k}" x="${g.xs.join(' ')}" y="${g.ys.join(' ')}">${esc(g.chars)}</text>`)
        .join(''),
    );
    let d = 0;
    for (let k = p; k < Math.min(pages, p + step); k++) d += delays[k] ?? 100;
    durations.push(d / a.speed);
  }
  return { frames, durations, cols, rows, file: basename(src) };
}

function asciiCss(an) {
  const total = an.durations.reduce((x, y) => x + y, 0);
  let cum = 0;
  let css = `.af{visibility:hidden;animation-duration:${Math.round(total)}ms;animation-timing-function:step-end;animation-iteration-count:infinite}`;
  css += `@media (prefers-reduced-motion: reduce){.af{animation:none;visibility:hidden}.af.first{visibility:visible}}`;
  an.durations.forEach((d, i) => {
    const s = (cum / total) * 100;
    cum += d;
    const e = (cum / total) * 100;
    const last = i === an.durations.length - 1;
    const vis = (v) => `visibility:${v}`;
    let kf = i === 0 ? `0%{${vis('visible')}}` : `0%{${vis('hidden')}}${s.toFixed(4)}%{${vis('visible')}}`;
    if (!last) kf += `${e.toFixed(4)}%,100%{${vis('hidden')}}`;
    css += `@keyframes a${i}{${kf}}`;
  });
  return css;
}

/** "2026-10-07 07:05 UTC+8" in the given IANA timezone. */
function stamp(tz) {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offMin = Math.round((asUtc - Math.floor(now.getTime() / 60000) * 60000) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = offMin === 0 ? 'UTC' : `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : ''}`;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${off}`;
}

/* ───────────────────────── render ───────────────────────── */

const data = has('mock') ? mockData() : await fetchData();
const W = 900;
let out = '';

// 1) intro prompt + profile.d / languages box
out += prompt(20, cfg.commands.intro.replace('{name}', displayName));

const fields = cfg.fields.map((f) => {
  const color = col(f.color);
  const q = f.quote !== false;
  const wrap = (v) => `<tspan fill="${color}">${q ? '&quot;' + esc(v) + '&quot;' : esc(v)}</tspan>`;
  const val = Array.isArray(f.value) ? `(${f.value.map(wrap).join(' ')})` : wrap(f.value);
  return `${esc(f.key)}=${val}`;
});

const chips = cfg.skills
  .map((s) => (typeof s === 'string' ? { name: s } : s))
  .map((s) => ({ name: s.name, color: s.color ? col(s.color) : langColor(s.name) }));
const chipLines = [];
{
  let line = [];
  let len = 0;
  for (const c of chips) {
    const w = c.name.length + 2; // name + quotes
    const add = line.length ? w + 1 : w; // +1 for the separating space
    if (line.length && len + add > cfg.chipsMaxChars) {
      chipLines.push(line);
      line = [];
      len = 0;
    }
    len += line.length ? w + 1 : w;
    line.push(c);
  }
  if (line.length) chipLines.push(line);
}

const n1 = Math.max(fields.length, chipLines.length, 1);
const b1 = 42 + 20 * n1;
out += box({
  x0: 6, y0: 30, x1: 894, y1: b1,
  titles: [
    { x: 24, text: cfg.labels.fields, color: 'cyan' },
    { x: 518, text: cfg.labels.skills, color: 'magenta' },
  ],
  dividers: [500],
});
fields.forEach((f, i) => {
  out += `<text x="18" y="${52 + 20 * i}" class="body" fill="var(--text)">${f}</text>`;
});
chipLines.forEach((line, i) => {
  out +=
    `<text x="520" y="${52 + 20 * i}" class="body">` +
    line.map((c) => `<tspan fill="${c.color}">&quot;${esc(c.name)}&quot;</tspan>`).join('<tspan fill="var(--text)"> </tspan>') +
    `</text>`;
});

// 2) stats + activity
const p2 = b1 + 22;
out += prompt(p2, cfg.commands.stats);
const t2 = p2 + 10;
const statItems = cfg.stats
  .map((s) => (typeof s === 'string' ? { key: s } : s))
  .filter((s) => STAT_DEFS[s.key] && data[s.key] !== undefined);
const rows2 = Math.max(4, Math.ceil(statItems.length / 2));
const lastRow = t2 + 26 + 21 * (rows2 - 1);
const b2 = lastRow + 21;
out += box({
  x0: 6, y0: t2, x1: 894, y1: b2,
  titles: [
    { x: 24, text: cfg.labels.stats, color: 'yellow' },
    { x: 436, text: cfg.labels.activity, color: 'green' },
  ],
  dividers: [420],
});
statItems.forEach((s, i) => {
  const x = i % 2 ? 202 : 18;
  const y = t2 + 26 + 21 * Math.floor(i / 2);
  const v = s.key === 'joined' ? data.joined : fmt(data[s.key]);
  out += `<text x="${x}" y="${y}" class="body" fill="var(--text)">${v}<tspan fill="var(--muted)"> ${esc(s.label || STAT_DEFS[s.key])}</tspan></text>`;
});

{
  const X0 = 435, X1 = 878, H = lastRow - (t2 + 24);
  const ws = data.weeks;
  const max = Math.max(1, ...ws.map((w) => w.total));
  const pts = ws.map((w, i) => [X0 + (i * (X1 - X0)) / Math.max(1, ws.length - 1), lastRow - (w.total / max) * H]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  out += `<path d="${line} L ${X1} ${lastRow} L ${X0} ${lastRow} Z" fill="var(--green)" fill-opacity="0.16" />`;
  out += `<path d="${line}" fill="none" stroke="var(--green)" stroke-width="2" />`;
  out += `<line x1="${X0}" y1="${lastRow}" x2="${X1}" y2="${lastRow}" stroke="var(--muted)" stroke-opacity="0.45" />`;
  const ticks = [0, 10, 20, 30, 40, ws.length - 1].filter((v, i, a) => v < ws.length && a.indexOf(v) === i);
  ticks.forEach((idx, k) => {
    const [x] = pts[idx];
    const anchor = k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle';
    const d = ws[idx].start; // YYYY-MM-DD
    out += `<text x="${(k === ticks.length - 1 ? X1 : x).toFixed(2)}" y="${lastRow + 15}" text-anchor="${anchor}" class="utility" fill="var(--muted)">${d.slice(2, 4)}/${d.slice(5, 7)}</text>`;
  });
}

// 3) languages by commit
const p3 = b2 + 22;
out += prompt(p3, cfg.commands.languages);
const t3 = p3 + 10;
const excl = new Set(cfg.languages.exclude.map((s) => s.toLowerCase()));
const langs = data.languages
  .filter((l) => !excl.has(l.name.toLowerCase()))
  .sort((a, b) => b.count - a.count)
  .slice(0, cfg.languages.max);
const totalLang = langs.reduce((a, l) => a + l.count, 0) || 1;
const lastLang = t3 + 27 + 20 * Math.max(0, langs.length - 1);
const b3 = lastLang + 11;
out += box({ x0: 6, y0: t3, x1: 478, y1: b3, titles: [{ x: 24, text: cfg.labels.languages, color: 'blue' }] });
langs.forEach((l, i) => {
  const y = t3 + 27 + 20 * i;
  const pct = (l.count / totalLang) * 100;
  out += `<text x="18" y="${y}" class="body" fill="var(--text)">${esc(l.name)}</text>`;
  out += `<rect x="145" y="${y - 11}" width="228" height="12" fill="var(--muted)" fill-opacity="0.14" shape-rendering="crispEdges" />`;
  out += `<rect x="145" y="${y - 11}" width="${((pct / 100) * 228).toFixed(2)}" height="12" fill="${langColor(l.name, l.color)}" shape-rendering="crispEdges" />`;
  out += `<text x="466" y="${y}" text-anchor="end" class="body" fill="var(--muted)">${Math.round(pct)}%</text>`;
});

// 4) optional ASCII animation
let contentBottom = b3;
let extraCss = '';
if (cfg.ascii.enabled) {
  const an = await buildAscii(cfg.ascii);
  if (an) {
    const p4 = b3 + 26;
    out += prompt(p4, cfg.commands.ascii.replace('{file}', an.file));
    const top = p4 + 12;
    const S = Math.min(0.8, 864 / (an.cols * 6));
    out += `<g id="terminal-animation" role="img" aria-label="${esc(an.file)} rendered as animated ASCII">`;
    out += `<g class="ascii-glyphs" transform="translate(18 ${top}) scale(${S.toFixed(4)})" aria-hidden="true">`;
    out += an.frames
      .map((f, i) => `<g class="af${i === 0 ? ' first' : ''}" style="animation-name:a${i}">${f}</g>`)
      .join('');
    out += `</g></g>`;
    extraCss = asciiCss(an) + `.ascii-glyphs{font-family:Consolas,"Liberation Mono",Menlo,monospace;font-size:10px;font-weight:700}`;
    contentBottom = Math.ceil(top + an.rows * 10 * S);
  }
}

// 5) footer: idle prompt with blinking cursor + "updated" stamp
let height = contentBottom + 14;
if (cfg.footer.enabled) {
  const fy = contentBottom + 24;
  if (cfg.footer.prompt) {
    out +=
      `<text x="18" y="${fy}" class="body"><tspan fill="var(--green)">${esc(promptUser)}@${esc(cfg.host)}</tspan>` +
      `<tspan fill="var(--text)">:</tspan><tspan fill="var(--blue)">~</tspan>` +
      `<tspan fill="var(--text)">$ </tspan><tspan fill="var(--text)" class="cursor">█</tspan></text>`;
  }
  if (cfg.footer.timestamp) {
    out += `<text x="882" y="${fy}" text-anchor="end" class="utility" fill="var(--muted)">updated ${stamp(cfg.footer.timezone)}</text>`;
  }
  height = fy + 10;
}

/* ───────────────────────── assemble ───────────────────────── */

const MONO = `"Cascadia Mono","SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(displayName)} native shell profile</title>
  <desc id="desc">A transparent terminal-style profile showing details, live GitHub statistics and top languages for ${esc(login)}.</desc>
  <style>
    :root{color-scheme:light dark;--text:#24292F;--muted:#57606A;--green:#1A7F37;--blue:#0969DA;--cyan:#0A7B83;--yellow:#9A6700;--magenta:#8250DF}
    @media (prefers-color-scheme: dark){:root{--text:#C9D1D9;--muted:#8B949E;--green:#3FB950;--blue:#58A6FF;--cyan:#39C5CF;--yellow:#D29922;--magenta:#BC8CFF}}
    .body{font-family:${MONO};font-size:14px;font-variant-ligatures:none}
    .utility{font-family:${MONO};font-size:11px;font-variant-ligatures:none}
    .cursor{animation:blink 1.1s step-end infinite}@keyframes blink{50%{opacity:0}}
    @media (prefers-reduced-motion: reduce){.cursor{animation:none}}
    ${extraCss}
  </style>
  ${out}
</svg>
`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, svg);
console.log(`wrote ${outPath} (${(svg.length / 1024).toFixed(1)} KB, ${W}×${height})`);
