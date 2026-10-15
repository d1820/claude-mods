import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

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

// Current git branch + repo root (module scope so top-level helpers can use them;
// one module instance per session, reset on reload).
let branch = ''
let repoRoot = ''
let branchTries = 0

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
      try {
        const files = await $.fs.list(PLANS)
        const match = files.find(
          f => f.kind === 'file' && f.name.endsWith('.md') && f.name.includes(q),
        )
        if (match) {
          await update($, planName, () => match.name)
          if (branch) await $.store.set(`plan:${branch}`, match.name)

          return { text: `Active plan set: ${match.name}` }
        }

        return { text: `No plan file matching "${q}" in ${PLANS}` }
      } catch {
        return { text: 'Could not read the plans folder.' }
      }
    }

    const cur = await read($, planName)

    return {
      text: cur
        ? `Active plan: ${PLANS}/${cur}`
        : 'No active plan for this branch yet.',
    }
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
    const planMatch = isMut || isRead ? fp.match(PLAN_RE) : null
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
    // project .claude). Write sets it; a Read bootstraps only when unset.
    if (artMatch?.[1]) {
      const dir = artMatch[1].replace(/\\/g, '/')
      const cur = await read($, artifactDir)
      if (isMut || cur === null) {
        await update($, artifactDir, () => dir)
        // Durable per branch (like the plan) so it survives reloads/new sessions.
        if (isMut && branch) await $.store.set(`artifact:${branch}`, dir)
      }
    }
    // Plan: a Write sets + persists per branch; a Read bootstraps $.state when unset.
    if (planMatch?.[1]) {
      const name = planMatch[1]
      const prev = await read($, planName)
      const take = isMut ? name !== prev : prev === null
      if (take) {
        await update($, planName, () => name)
        if (isMut && branch) await $.store.set(`plan:${branch}`, name)
        try {
          const text = await $.fs.read(`${PLANS}/${name}`)
          const marker = text.match(MARKER_RE)
          if (marker?.[1]) {
            const dir = await resolveArtifactDir($, repoRoot, marker[1])
            if (dir) await update($, artifactDir, () => dir)
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
      await update($, planName, () => name)
      try {
        const text = await $.fs.read(`${PLANS}/${name}`)
        const marker = text.match(MARKER_RE)
        if (marker?.[1]) {
          const dir = await resolveArtifactDir($, repoRoot, marker[1])
          if (dir) await update($, artifactDir, () => dir)
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
        const dir = full[1].replace(/\\/g, '/')
        await update($, artifactDir, () => dir)
      } else {
        const am = ans.match(ART_SLUG_RE)
        if (am?.[1]) {
          const resolved = await resolveArtifactDir($, repoRoot, am[1])
          if (resolved) await update($, artifactDir, () => resolved)
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

    const { Box, Text, Button, Link } = $.ui.resolve(e)

    return (
      <Box flexWrap="wrap">
        <Text dimColor>{`session ${sessionTools} tools · ${fmtTokens(tok)} tok `}</Text>
        {plan && <Text dimColor>· plan: </Text>}
        {plan && <Link href={`vscode://file/${PLANS}/${plan}`}>{plan}</Link>}
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
    const now = await $.clock.now()
    const agents = await $.agent.list()
    const sTurns = await read($, sessTurns)
    const sAborts = await read($, sessAborts)
    const cuss = await read($, sessCuss)
    const intr = sTurns > 0 ? `interrupts ${sAborts}/${sTurns}` : ''

    let artCount = 0
    if (dir) {
      try {
        const files = await $.fs.list(dir)
        artCount = files.filter(f => f.kind === 'file').length
      } catch {
        /* folder gone */
      }
    }

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
              <Link href={`file:///${dir}`}>{`view ${artCount} artifacts`}</Link>
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
