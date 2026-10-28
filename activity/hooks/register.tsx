import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, FsEntry } from 'claude-code'

import type { ToolCall } from '../types'

const PANE = 'activity'
const IDLE_BELL_MS = 60_000
const CAP = 3

// User-profile paths are resolved at runtime from the environment so the mod is
// portable (any machine / OS), never a hardcoded home. ensureEnv fills them once.
let home = ''
let PLANS = ''
let PROFILE_ARTIFACTS = ''
let envTries = 0
async function ensureEnv($: EngineInterface): Promise<void> {
  if (home || envTries >= 3) return
  envTries++
  try {
    const h = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    if (!h) return
    home = h.replace(/\\/g, '/')
    PLANS = `${home}/.claude/plans`
    PROFILE_ARTIFACTS = `${home}/.claude/artifacts`
  } catch {
    /* env unavailable (e.g. a test harness) — leave paths empty, retry capped */
  }
}

// This session's own touches identify the active plan / artifact folder —
// never a mtime guess (unreliable across concurrent sessions).
const PLAN_RE = /[\\/]\.claude[\\/]plans[\\/]([^\\/]+\.md)$/i
// Captures the FULL artifact folder path (…/.claude/artifacts/<slug>), so the
// count/link work for BOTH profile and project .claude, wherever I wrote.
const ART_RE = /(.*[\\/]\.claude[\\/]artifacts[\\/][^\\/]+)[\\/]/i
const MARKER_RE = /<!--\s*artifacts:\s*([^\s>]+)\s*-->/i
// A plan path printed anywhere in my answer text (I often state it without
// touching the file via a tool). Captures just the filename.
const PLAN_PATH_RE = /\.claude[\\/]plans[\\/]([^\s"'`<>|\\/]+\.md)/i
// An artifact folder mentioned in my answer (…/.claude/artifacts/<slug>). Captures
// the slug; resolved to a real folder against the repo + profile.
const ART_SLUG_RE = /\.claude[\\/]artifacts[\\/]([^\s"'`<>|\\/]+)/i

// Rage meter: a prompt scores +1 (never more) when it trips ANY trigger — a profanity/
// insult/hostility word, or "yelling" (a mostly-UPPERCASE message, so a stray acronym
// like SQL/BFF does not count). Strong profanity matches anywhere so compounds count
// (dumbfuck, motherfucker, clusterfuck); ambiguous words are whole-word only. Slurs are
// deliberately excluded. Shown in the pane header.
const CUSS_RE =
  /fuck|motherf\w*|clusterf\w*|dumbf\w*|shit|bullshit|dumbshit|bitch\w*|cunt|bastard|asshole|dumbass|jackass|smartass|dickhead|douche\w*|wank\w*|twat|bollock\w*|prick|tosser|\bass\b|\bdamn\w*|\bhell\b|\bcrap\w*|\bpiss\w*|\bdick\b|\bcock\b|\bdie\b|\bdead\b|\bhate\w*|\bkill\w*|\bsuck\w*|\bdumb\b|\bstupid\w*|\bidiot\w*|\bmoron\w*|\bimbecile\w*|\bjerk\b|\bloser\w*|\buseless\b|\bpathetic\b|\bworthless\b|\bincompet\w*|\bgarbage\b|\btrash\b|\blame\b|\bwtf\b|\bgoddam\w*/i
// User-configured extra trigger words (regex built per load in register, from userConfig);
// appended to the built-in list.
let extraRe: RegExp | null = null
function isRage(text: string): boolean {
  if (!text) return false
  if (CUSS_RE.test(text)) return true
  if (extraRe && extraRe.test(text)) return true
  // Yelling: enough letters and a clear majority uppercase (ignores a stray acronym).
  const letters = text.replace(/[^a-z]/gi, '')
  const upper = text.replace(/[^A-Z]/g, '')
  return letters.length >= 4 && upper.length / letters.length >= 0.6
}

const turnStats = atom({ plugin: 'activity', key: 'turnStats' } as const, null)
const perTool = atom({ plugin: 'activity', key: 'perTool' } as const, {})
const recent = atom({ plugin: 'activity', key: 'recent' } as const, [])
const isHidden = atom({ plugin: 'activity', key: 'isHidden' } as const, false)
const sessionTok = atom({ plugin: 'activity', key: 'sessionTok2' } as const, 0)
const planName = atom({ plugin: 'activity', key: 'planName' } as const, null)
const wi = atom({ plugin: 'activity', key: 'wi' } as const, null)
const artifactDir = atom({ plugin: 'activity', key: 'artifactDir' } as const, null)
// Every distinct slug folder this session has WRITTEN to (base included). Length
// > 1 means I spread scratch across folders — the pane flags it so you can tell
// me to consolidate into the pinned base. Session-scoped, like the counters.
const artifactSlugs = atom({ plugin: 'activity', key: 'artifactSlugs' } as const, [])
const agentStart = atom({ plugin: 'activity', key: 'agentStart' } as const, {})
const agentUsage = atom({ plugin: 'activity', key: 'agentUsage' } as const, {})
const sessTurns = atom({ plugin: 'activity', key: 'sessTurns' } as const, 0)
const sessAborts = atom({ plugin: 'activity', key: 'sessAborts' } as const, 0)
const sessCuss = atom({ plugin: 'activity', key: 'sessCuss' } as const, 0)

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// The filename of a path (for display); the planName atom stores a full path.
const baseName = (p: string): string =>
  p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

// --- Interrupts (friction) tally: THIS SESSION only, held in $.state ---
// Counts main-loop turns and how many you hard-interrupted (turn.complete isAborted).
// Session-scoped (like sessionTok): survives /reload-plugins, resets on a new session.
// NOT accuracy: an abort may be a correction OR a scope change / new idea.

// Resolve a bare artifact slug (from a plan marker) to a real folder, checking
// BOTH the project repo and the user profile — whichever exists.
async function resolveArtifactDir(
  $: EngineInterface,
  repoRoot: string,
  slug: string,
): Promise<string | null> {
  await ensureEnv($)
  const candidates = [
    repoRoot ? `${repoRoot}/.claude/artifacts/${slug}` : '',
    `${PROFILE_ARTIFACTS}/${slug}`,
  ]
  for (const cand of candidates) {
    if (!cand) continue
    try {
      await $.fs.list(cand)

      return cand
    } catch {
      /* not here */
    }
  }

  return null
}

// Record a slug folder I touched. The FIRST one pins the session base (shown in
// the pane) and, when it's a real write on a known branch, persists per branch so
// it survives reloads. Writes to any OTHER folder are added to the drift set only
// (never repoint the base) — a read never counts, so a reference-read can't inflate
// the drift. isMut:false callers (plan markers, answer-text) only ever pin the base.
async function noteSlug(
  $: EngineInterface,
  dir: string,
  opts: { isMut?: boolean; branch?: string } = {},
): Promise<void> {
  const cur = await read($, artifactDir)
  if (cur === null) {
    await update($, artifactDir, () => dir)
    if (opts.isMut && opts.branch) await $.store.set(`artifact:${opts.branch}`, dir)
    await update($, artifactSlugs, list => (list.includes(dir) ? list : [...list, dir]))
  } else if (opts.isMut) {
    await update($, artifactSlugs, list => (list.includes(dir) ? list : [...list, dir]))
  }
}

// Files under a folder, counted recursively ($.fs.list is one level; artifacts
// nest scratch in subfolders). Depth-capped so a deep tree can't stall a render.
async function countFilesDeep(
  $: EngineInterface,
  dir: string,
  depth = 0,
): Promise<number> {
  if (depth > 6) return 0
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const entry of entries) {
    if (entry.kind === 'file') n++
    else if (entry.kind === 'dir') {
      n += await countFilesDeep($, `${dir}/${entry.name}`, depth + 1)
    }
  }
  return n
}

// Current git branch + repo root (module scope so top-level helpers can use them;
// one module instance per session, reset on reload).
let branch = ''
let repoRoot = ''
let branchTries = 0

// A plan file touched under the repo: `<repoRoot>/<child>/plans/<name>.md` — one
// directory deep, which covers both `<repoRoot>/.claude/plans` and any
// `<repoRoot>/<dir>/plans`. Returns the bare filename, else null. Bounded to
// repoRoot so an unrelated `plans/` folder elsewhere never trips it.
function matchProjectPlan(fp: string): string | null {
  if (!repoRoot || !fp) return null
  const n = fp.replace(/\\/g, '/')
  if (!n.toLowerCase().startsWith(repoRoot.toLowerCase() + '/')) return null
  const rel = n.slice(repoRoot.length + 1)
  const m = rel.match(/^[^/]+\/plans\/([^/]+\.md)$/i)

  return m?.[1] ?? null
}

// Candidate plan directories in precedence order: the profile home first (the
// canonical location), then every `<repoRoot>/<child>/plans` (covers
// `<repoRoot>/.claude/plans` and any `<repoRoot>/<dir>/plans`). Deduped.
async function planDirs($: EngineInterface): Promise<string[]> {
  await ensureEnv($)
  const dirs: string[] = []
  if (PLANS) dirs.push(PLANS)
  if (repoRoot) {
    try {
      for (const k of await $.fs.list(repoRoot)) {
        if (k.kind === 'dir') dirs.push(`${repoRoot}/${k.name}/plans`)
      }
    } catch {
      /* repo root unreadable */
    }
  }

  return [...new Set(dirs)]
}

// Resolve a bare plan filename to a full path. When the same name exists in more
// than one candidate dir, the most recently modified copy wins (mtime from the
// directory listing — no extra stat). Null when it is in none of them.
async function resolvePlanPath($: EngineInterface, name: string): Promise<string | null> {
  let best: { path: string; mtimeMs: number } | null = null
  for (const dir of await planDirs($)) {
    let files
    try {
      files = await $.fs.list(dir)
    } catch {
      continue // dir does not exist here
    }
    const hit = files.find(f => f.kind === 'file' && f.name === name)
    if (hit && (best === null || hit.mtimeMs > best.mtimeMs)) {
      best = { path: `${dir}/${name}`, mtimeMs: hit.mtimeMs }
    }
  }

  return best?.path ?? null
}

// Normalize a stored plan value to a usable path. New values are already full
// paths; a legacy bare filename (from an earlier version) is resolved (newest-
// mtime), falling back to the profile dir so a link is never empty.
async function asPlanPath($: EngineInterface, stored: string): Promise<string> {
  if (stored.includes('/') || stored.includes('\\')) return stored

  return (await resolvePlanPath($, stored)) ?? `${PLANS}/${stored}`
}

// The most recently modified `*.md` across all candidate dirs, optionally limited
// to names containing `fragment`. Null when none match. Drives both `/plan <q>`
// and the inline refresh token.
async function newestPlan($: EngineInterface, fragment = ''): Promise<string | null> {
  let best: { path: string; mtimeMs: number } | null = null
  for (const dir of await planDirs($)) {
    let files
    try {
      files = await $.fs.list(dir)
    } catch {
      continue // dir does not exist here
    }
    for (const f of files) {
      if (f.kind !== 'file' || !f.name.endsWith('.md') || !f.name.includes(fragment)) continue
      if (best === null || f.mtimeMs > best.mtimeMs) {
        best = { path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs }
      }
    }
  }

  return best?.path ?? null
}

// Resolve the git branch for a directory, handling three cases the old ".git/HEAD" read
// missed: a deep SUBFOLDER (walk up to the repo root), a normal checkout (.git is a dir ->
// .git/HEAD), and a WORKTREE (.git is a FILE "gitdir: <path>" -> <path>/HEAD). Returns the
// repo/worktree root + branch name, or null when no git is found.
async function resolveGit(
  $: EngineInterface,
  startDir: string,
): Promise<{ root: string; branch: string } | null> {
  let dir = startDir.replace(/\\/g, '/').replace(/\/+$/, '')
  for (let i = 0; i < 12 && dir; i++) {
    let head: string | null = null
    try {
      head = await $.fs.read(`${dir}/.git/HEAD`) // .git is a directory
    } catch {
      try {
        const dotgit = await $.fs.read(`${dir}/.git`) // .git is a file (worktree)
        const gm = dotgit.match(/gitdir:\s*(.+)/)
        if (gm?.[1]) head = await $.fs.read(`${gm[1].trim().replace(/\\/g, '/')}/HEAD`)
      } catch {
        /* no .git here */
      }
    }
    if (head) {
      const bm = head.match(/ref:\s*refs\/heads\/(.+)/)
      return { root: dir, branch: bm?.[1]?.trim() ?? '' }
    }
    const parent = dir.replace(/\/[^/]+$/, '')
    if (parent === dir) break
    dir = parent
  }
  return null
}

// Detect branch -> WI (+ recover plan/artifact from $.store).
// Runs on session.start AND every turn until detected — session.start does NOT
// fire on /reload-plugins, so a turn is the only reliable trigger then.
async function ensureContext($: EngineInterface): Promise<void> {
  // Stop once found, or after 5 tries (detached HEAD / non-git never resolves).
  if (branch || branchTries >= 5) return
  branchTries++
  try {
    const cwd = await $.session.cwd()
    const git = cwd ? await resolveGit($, cwd) : null
    repoRoot = git?.root ?? (cwd ? cwd.replace(/\\/g, '/') : '')
    branch = git?.branch ?? ''
    const m = branch.match(/(?:^|[-_/])(\d{4,6})(?:[-_/]|$)/)
    if (m?.[1]) await update($, wi, () => m[1] ?? null)
    if (branch) {
      const storedPlan = await $.store.get(`plan:${branch}`)
      if (typeof storedPlan === 'string') await update($, planName, () => storedPlan)
      const storedArt = await $.store.get(`artifact:${branch}`)
      if (typeof storedArt === 'string') await update($, artifactDir, () => storedArt)
    }
  } catch {
    /* not a git checkout */
  }
}

export const register: Register = (on, options) => {
  // Per-turn counters for the main loop; reset each prompt, read at turn end.
  let startedAt = 0
  let tools = 0
  // Idle bell: a one-shot timer armed when a main-loop turn ends, cancelled
  // when the next turn starts. Fires at most once per idle gap. No render loop.
  let idleBell: { cancel: () => void } | null = null
  // Pane auto-open is one-shot per module load: session.start opens it on a real session
  // start; this flag lets prompt.submit re-open it after /reload-plugins (where session.start
  // does not fire) without fighting a manual close afterward.
  let paneAutoOpened = false
  // Azure DevOps work-items base URL comes from this install's userConfig (set per
  // machine); the band's WI link only renders when it is configured.
  const workItemsUrl = typeof options?.workItemsUrl === 'string' ? options.workItemsUrl : ''
  // Extra rage words from userConfig (comma/space separated), appended to the built-in
  // list. Rebuilt each load so a config change takes effect on the next reload.
  const extraWords = (typeof options?.extraRageWords === 'string' ? options.extraRageWords : '')
    .split(/[\s,]+/)
    .map(w => w.trim())
    .filter(Boolean)
  extraRe = extraWords.length
    ? new RegExp('\\b(' + extraWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'i')
    : null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'activity',
      description: 'Show live activity (tools, subagents, timing) in a pane',
    })
    await $.command.register({
      name: 'plan',
      description: 'Show or set the active plan for this branch (/plan <name-fragment>)',
    })
    void $.ui.open({ id: PANE, title: 'Activity' })
    paneAutoOpened = true

    await ensureEnv($)
    await ensureContext($)

    return next(e)
  })

  on('command.run', { command: 'activity' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Activity' })
    paneAutoOpened = true

    return { text: 'Activity pane opened.' }
  })

  // /plan            -> show the active plan for this branch
  // /plan <fragment> -> set it (overrides; persisted per branch in $.store)
  on('command.run', { command: 'plan' }, async ($, e) => {
    await ensureEnv($)
    const q = e.args.trim()
    if (q) {
      // Across every layer, the newest-modified file whose name contains the
      // fragment wins (the plan you touched most recently is almost always the one).
      const path = await newestPlan($, q)
      if (path) {
        await update($, planName, () => path)
        if (branch) await $.store.set(`plan:${branch}`, path)

        return { text: `Active plan set: ${path}` }
      }

      return { text: `No plan file matching "${q}" in: ${(await planDirs($)).join(', ')}` }
    }

    const cur = await read($, planName)
    if (!cur) return { text: 'No active plan for this branch yet.' }

    return { text: `Active plan: ${await asPlanPath($, cur)}` }
  })

  on('prompt.submit', async ($, e, next) => {
    // You came back and are typing -> cancel any pending idle bell, re-arm later.
    idleBell?.cancel()
    idleBell = null

    // Pane opens in session.start, which does NOT fire on /reload-plugins. Open once here
    // too so a reload re-shows it; one-shot so a manual close is respected afterward.
    if (!paneAutoOpened) {
      paneAutoOpened = true
      void $.ui.open({ id: PANE, title: 'Activity' })
    }

    // session.start does not fire on /reload-plugins; detect here too (no-op once done).
    await ensureEnv($)
    await ensureContext($)
    startedAt = await $.clock.now()
    tools = 0

    // Rage meter: +1 for this prompt if it trips any trigger (one point per message).
    if (isRage(e.text ?? '')) await update($, sessCuss, n => n + 1)

    // Inline refresh token: `/planPathRefresh` anywhere in the prompt switches the
    // active plan to the newest plan file across all layers (handy after a reload
    // left an old plan active). The token is stripped so the model never sees it.
    const text = e.text ?? ''
    if (/\/planPathRefresh\b/i.test(text)) {
      const path = await newestPlan($)
      if (path) {
        await update($, planName, () => path)
        if (branch) await $.store.set(`plan:${branch}`, path)
      }
      const stripped = text.replace(/\s*\/planPathRefresh\b\s*/gi, ' ').trim()

      return next({ ...e, text: stripped })
    }

    return next(e)
  })

  // Claude asking the user something -> immediate bell (rare, genuine).
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const text = 'Claude is asking you a question.'
    $.ui.toast(text)
    void $.ui.notify(text, { title: 'Needs you' })

    return next(e)
  })

  // One no-matcher tool.call hook (the engine allows only one): per-tool timing
  // + recent list, AND observing this session's plan/artifact file touches.
  on('tool.call', async ($, e, next) => {
    const fp = (e as { file_path?: string }).file_path ?? ''
    // A Write/Edit marks the active plan/artifact authoritatively; a Read only
    // BOOTSTRAPS it when nothing is set yet — so a reference-read never hijacks an
    // already-known plan, but resuming and reading the plan still populates it.
    const isMut = e.tool === 'Write' || e.tool === 'Edit'
    const isRead = e.tool === 'Read'
    // A plan touch: `.claude/plans/<name>.md` anywhere (profile or project), OR a
    // repo plan at `<repoRoot>/<child>/plans/<name>.md`. The full touched path is
    // stored (not just the name), so the link/marker are unambiguous.
    const isPlan =
      (isMut || isRead) && (PLAN_RE.test(fp) || matchProjectPlan(fp) !== null)
    const artMatch = isMut || isRead ? fp.match(ART_RE) : null

    if (e.agentId === undefined) tools += 1

    const call: ToolCall = {
      id: e.tool_use_id,
      tool: e.tool,
      isDone: false,
      agentId: e.agentId,
    }
    await update($, recent, list => [...list, call].slice(-50))
    const begin = await $.clock.now()

    const ran = await next(e)

    const ms = (await $.clock.now()) - begin
    await update($, perTool, map => {
      const prev = map[e.tool] ?? { count: 0, ms: 0 }

      return { ...map, [e.tool]: { count: prev.count + 1, ms: prev.ms + ms } }
    })
    await update($, recent, list =>
      list.map(one => (one.id === call.id ? { ...one, isDone: true } : one)),
    )

    // Artifacts: full folder path from the actual touch (covers profile AND
    // project .claude). First slug pins the base; later writes grow the drift set.
    if (artMatch?.[1]) {
      await noteSlug($, artMatch[1].replace(/\\/g, '/'), { isMut, branch })
    }
    // Plan: a Write sets + persists per branch; a Read bootstraps $.state when unset.
    if (isPlan) {
      const path = fp.replace(/\\/g, '/')
      const prev = await read($, planName)
      const take = isMut ? path !== prev : prev === null
      if (take) {
        await update($, planName, () => path)
        if (isMut && branch) await $.store.set(`plan:${branch}`, path)
        try {
          const text = await $.fs.read(path)
          const marker = text.match(MARKER_RE)
          if (marker?.[1]) {
            const dir = await resolveArtifactDir($, repoRoot, marker[1])
            if (dir) await noteSlug($, dir)
          }
        } catch {
          /* ignore */
        }
      }
    }

    return ran
  }).catch((_$, e, next) => next(e))

  // Record each subagent's spawn time so the pane can show elapsed.
  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const res = await next(e)
    const id = (res as { agentId?: string } | undefined)?.agentId
    if (id) {
      await update($, agentStart, map => (map[id] ? map : { ...map, [id]: now }))
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    // Bootstrap the plan from a path printed in my answer — ONLY when $.state has
    // none yet (I often state the path without touching the file via a tool).
    const pm = (e.answer ?? '').match(PLAN_PATH_RE)
    if (pm?.[1] && (await read($, planName)) === null) {
      const name = pm[1]
      const path = (await resolvePlanPath($, name)) ?? `${PLANS}/${name}`
      await update($, planName, () => path)
      try {
        const text = await $.fs.read(path)
        const marker = text.match(MARKER_RE)
        if (marker?.[1]) {
          const dir = await resolveArtifactDir($, repoRoot, marker[1])
          if (dir) await noteSlug($, dir)
        }
      } catch {
        /* ignore */
      }
    }

    // Bootstrap the artifact folder from my answer — when unset. Prefer a full
    // absolute path if I printed one (repo-independent); else resolve a bare slug.
    if ((await read($, artifactDir)) === null) {
      const ans = e.answer ?? ''
      const full = ans.match(
        /([A-Za-z]:[\\/][^\s"'`<>|]*?[\\/]\.claude[\\/]artifacts[\\/][^\s"'`<>|\\/]+)/i,
      )
      if (full?.[1]) {
        await noteSlug($, full[1].replace(/\\/g, '/'))
      } else {
        const am = ans.match(ART_SLUG_RE)
        if (am?.[1]) {
          const resolved = await resolveArtifactDir($, repoRoot, am[1])
          if (resolved) await noteSlug($, resolved)
        }
      }
    }

    const u = e.usage
    // New tokens only: uncached input + output. Excludes cache_read (the whole
    // cached prompt re-read each turn) and cache_creation (the context being
    // cached) — both dwarf real work and made turns read ~1M tokens.
    const tok = u ? u.input_tokens + u.output_tokens : 0
    if (tok > 0) await update($, sessionTok, n => n + tok)

    // A subagent's turn carries an agentId: accumulate its per-agent tokens too.
    if (e.agentId) {
      const aid = e.agentId
      if (u) {
        await update($, agentUsage, map => {
          const prev = map[aid] ?? {
            turns: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheCreation: 0,
          }

          return {
            ...map,
            [aid]: {
              turns: prev.turns + 1,
              input: prev.input + u.input_tokens,
              output: prev.output + u.output_tokens,
              cacheRead: prev.cacheRead + u.cache_read_input_tokens,
              cacheCreation: prev.cacheCreation + u.cache_creation_input_tokens,
            },
          }
        })
      }

      return next(e)
    }

    // Main loop turn ended: update the band summary, then arm the idle bell.
    // If the next turn starts within IDLE_BELL_MS, prompt.submit cancels it.
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    await update($, turnStats, () => ({ seconds, tools, tokens: tok }))
    await update($, sessTurns, n => n + 1)
    if (e.isAborted) await update($, sessAborts, n => n + 1)

    idleBell?.cancel()
    idleBell = $.clock.after(IDLE_BELL_MS, () => {
      $.ui.toast('Claude is waiting on you.')
      void $.ui.notify('Your move', { title: 'Claude Code' })
      idleBell = null
    })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await ensureEnv($)
    const turn = await read($, turnStats)
    const hidden = await read($, isHidden)
    const toolMap = await read($, perTool)
    const tok = await read($, sessionTok)
    const plan = await read($, planName)
    const w = await read($, wi)
    const sessionTools = Object.values(toolMap).reduce((n, s) => n + s.count, 0)
    const quiet =
      e.props.hasSurvey ||
      hidden ||
      (turn === null && sessionTools === 0 && !plan && !w)

    if (quiet) {
      return next(e)
    }

    // The atom holds a full path (legacy bare names are resolved by asPlanPath).
    const planPath = plan ? await asPlanPath($, plan) : ''

    const { Box, Text, Button, Link } = $.ui.resolve(e)

    return (
      <Box flexWrap="wrap">
        <Text dimColor>{`session ${sessionTools} tools · ${fmtTokens(tok)} tok `}</Text>
        {plan && <Text dimColor>· plan: </Text>}
        {plan && <Link href={`vscode://file/${planPath}`}>{baseName(planPath)}</Link>}
        {w && <Text dimColor> · </Text>}
        {w &&
          (workItemsUrl ? (
            <Link href={`${workItemsUrl}/${w}`}>{`WI ${w}`}</Link>
          ) : (
            <Text dimColor>{`WI ${w}`}</Text>
          ))}
        <Text dimColor> </Text>
        <Button
          key="hide"
          label="Hide"
          onPress={() => update($, isHidden, () => true)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const turn = await read($, turnStats)
    const toolMap = await read($, perTool)
    const rec = await read($, recent)
    const starts = await read($, agentStart)
    const usage = await read($, agentUsage)
    const dir = await read($, artifactDir)
    const slugs = await read($, artifactSlugs)
    const now = await $.clock.now()
    const agents = await $.agent.list()
    const sTurns = await read($, sessTurns)
    const sAborts = await read($, sessAborts)
    const cuss = await read($, sessCuss)
    const intr = sTurns > 0 ? `interrupts ${sAborts}/${sTurns}` : ''

    // Recursive count of the pinned base slug; its name for the label; and how many
    // distinct slug folders I've written to (> 1 = drift worth surfacing).
    const artCount = dir ? await countFilesDeep($, dir) : 0
    const baseSlug = dir ? (dir.split('/').filter(Boolean).pop() ?? '') : ''
    const slugCount = slugs.length

    const toolRows = Object.entries(toolMap)
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, CAP)

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box>
            <Text bold>
              {turn
                ? `last ${turn.seconds}s · ${turn.tools} tools · ${fmtTokens(turn.tokens)} tok`
                : 'no turns yet'}
            </Text>
            {dir && <Text dimColor>{'  ·  '}</Text>}
            {dir && (
              <Link href={`file:///${dir}`}>{`${artCount} artifacts in ${baseSlug}`}</Link>
            )}
            {dir && slugCount > 1 && (
              <Text dimColor>{`  (${slugCount} slug folders)`}</Text>
            )}
          </Box>
          <Box>
            {cuss > 0 && <Text>{`🤬 ${cuss}  `}</Text>}
            {intr && <Text dimColor>{intr}</Text>}
          </Box>
        </Box>

        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" flexGrow={1}>
            <Text bold>Subagents</Text>
            {agents.length === 0 && <Text dimColor>none</Text>}
            {agents.slice(-CAP).map(a => {
              const start = starts[a.id]
              const elapsed = start ? Math.round((now - start) / 1000) : 0
              const u = usage[a.id]
              const tok = u ? u.input + u.output : 0

              return (
                <Text
                  key={a.id}
                  dimColor={a.status === 'completed' || a.status === 'idle'}
                >
                  {a.status} {a.type} · {elapsed}s
                  {u ? ` · ${u.turns}t · ${fmtTokens(tok)} tok` : ''} · {a.description}
                </Text>
              )
            })}
          </Box>

          <Box flexDirection="column" flexGrow={1}>
            <Text bold>Tools</Text>
            {toolRows.length === 0 && <Text dimColor>none yet</Text>}
            {toolRows.map(([name, s]) => (
              <Text key={name} dimColor>
                {name} ×{s.count} · {Math.round(s.ms / 1000)}s
              </Text>
            ))}
          </Box>

          <Box flexDirection="column" flexGrow={1}>
            <Text bold>Recent</Text>
            {rec.slice(-CAP).map(c => (
              <Text key={c.id} dimColor={c.isDone}>
                {c.isDone ? 'done' : 'runs'} {c.tool}
                {c.agentId ? ' (sub)' : ''}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>
    )
  })
}
