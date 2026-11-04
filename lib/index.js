/**
 * Host half of `dsh-tray-flash`.
 *
 * Watches the Session log for the two moments a person actually needs to be
 * called back — a turn that produced an answer nobody has looked at, and a tool
 * blocked on a human decision — and asks Windows to flash the Harness taskbar
 * button and title bar until the window comes to the foreground.
 *
 * The notification-area icon blinks at the same time: `DesktopTray` keeps its
 * image stable for the whole run (only the tooltip and menu are ever rebuilt), so
 * replacing it through `Shell_NotifyIconW` survives a locale change and is
 * always rebuilt from `resources/tray.ico` on the next start.
 *
 * Why the Session log and nothing else:
 *
 * - `turn/end` is committed once per finished turn, for every Session, and is
 *   the same event the Client uses to decide its unread dot.
 * - `approval/asked` is a log-only audit event appended inside an open turn. It
 *   plays no part in the approval decision, so observing it cannot influence
 *   policy.
 * - A pending question is visible as the `tool/call` for `ask_user_question`.
 *   Reading that event keeps this plugin out of the `user-questions/request`
 *   waterfall entirely — it never answers, never delegates, and therefore cannot
 *   swallow a prompt.
 *
 * The plugin registers no Client half: the unread dot is the Client's own
 * business, and everything here happens in the Host process.
 *
 * @module dsh-tray-flash
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAttention } from '../src/attention.mjs'
import { createDots } from '../src/dots.mjs'
import { loadKoffi } from '../src/koffi-loader.mjs'
import { resolveOptions } from '../src/options.mjs'
import { createTrayBlink, createTrayPort } from '../src/tray.mjs'
import { createWin32 } from '../src/win32.mjs'
import { createSelfTestRoutes } from '../src/selftest-route.mjs'

/** Package root, so the bundled transparent icon resolves regardless of install mode. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Where the application's own tray icon lives, relative to its resources folder.
 *
 * `process.resourcesPath` already IS the resources directory (`D:\DSH\resources`),
 * so this must not repeat the segment. An earlier version joined
 * `resources` + `resources/tray.ico` and produced a path that does not exist,
 * which made the original icon fail to load and silently disabled the blink.
 */
const ORIGINAL_ICON = 'tray.ico'

/** Stable Cordis plugin name; must match the package name. */
export const name = 'dsh-tray-flash'

/**
 * No required service: attention comes from the Session event bus, which every
 * Host context carries. The Web server is mounted on demand below through
 * `ctx.inject`, so a Host without one simply gets no self-test route.
 */
export const inject = []

/** Log prefix for every line this plugin writes. */
const LOG = 'tray-flash:'

/** Tool whose call means the model is waiting for a human answer. */
const QUESTION_TOOL = 'ask_user_question'

/**
 * Register the watcher.
 *
 * @param ctx - Host plugin context.
 * @param config - the patch row's `config`, or undefined.
 */
export function apply(ctx, config) {
  const { options, problems } = resolveOptions(config)
  for (const problem of problems) ctx.logger.warn(`${LOG} ${problem}`)
  if (options.enabled !== true) {
    ctx.logger.info(`${LOG} disabled by config`)
    return
  }

  const { koffi, failures } = loadKoffi({
    onMiss: (misses) => ctx.logger.warn(`${LOG} koffi unavailable, attention flash disabled (${misses.join('; ')})`),
  })
  if (koffi === undefined) {
    // A Host without FFI keeps running normally; only this plugin is inert.
    if (failures.length > 0) ctx.logger.warn(`${LOG} tried: ${failures.join(' | ')}`)
    return
  }

  let port
  try {
    port = createWin32(koffi)
  } catch (error) {
    ctx.logger.warn(`${LOG} user32 bindings failed, attention flash disabled: ${messageOf(error)}`)
    return
  }

  // The Host runs as a direct child of the Electron main process, which is the
  // process that owns the window. `process.ppid` is that identity; the Host's
  // own pid is included only so a future in-process window would still be found.
  const pids = [...new Set([process.ppid, process.pid])].filter((pid) => Number.isInteger(pid) && pid > 0)

  // The tray blink is optional in every direction: without the bundled
  // transparent icon, the shell32 bindings, or a discoverable tray host window it
  // simply stays off and the taskbar flash carries the signal alone.
  let tray
  if (options.trayBlink === true) {
    try {
      const blankIcon = join(PACKAGE_ROOT, 'assets', 'blank.ico')
      const trayPort = createTrayPort(koffi, port.user32, port.shell32, port)
      // `process.resourcesPath` is the resources directory itself under Electron;
      // under a bare Node host it is undefined and the fallback derives the same
      // directory from the executable. The segment is never repeated.
      const resourcesDir = process.resourcesPath ?? join(process.execPath, '..', 'resources')
      tray = createTrayBlink({
        port: trayPort,
        originalIconPath: join(resourcesDir, ORIGINAL_ICON),
        blankIconPath: blankIcon,
        pids,
        intervalMs: options.trayBlinkIntervalMs,
        logger: ctx.logger,
      })
    } catch (error) {
      ctx.logger.warn(`${LOG} tray blink unavailable: ${messageOf(error)}`)
      tray = undefined
    }
  }

  // The dots the Client draws in its session list decide when the flash ends.
  // The main session never earns a real dot, so this tracker also keeps a virtual
  // one for it, cleared when the window comes back to the foreground.
  const dots = createDots({
    staleSeconds: options.dotsStaleSeconds,
    virtualMain: options.virtualMainDot,
    logger: ctx.logger,
  })

  const attention = createAttention({
    port,
    options,
    pids,
    logger: ctx.logger,
    tray,
    dots,
  })

  ctx.logger.info(`${LOG} watching pid(s) ${pids.join(', ')} (caption=${String(options.flashCaption)}, tray=${String(options.trayBlink)}, dots=${String(options.stopWhenDotsClear)}, poll=${String(options.pollIntervalMs)}ms)`)

  ctx.effect(() => {
    const disposeSession = ctx.on('session/event', (session, event) => {
      // The Client names its main session on every report; read it lazily so a
      // turn that ends before the first report still flashes (as a background
      // session, which is the safe assumption).
      observe(attention, session, event, dots.currentSessionId())
    }, { global: true })
    return () => {
      disposeSession()
      attention.dispose()
      port.dispose()
    }
  }, 'tray-flash: session attention')

  if (options.allowTestFlash === true) {
    ctx.inject(['webServer'], (webCtx) => {
      const routes = createSelfTestRoutes({ attention, port, options, logger: webCtx.logger ?? ctx.logger })
      for (const route of routes) {
        webCtx.effect(() => webCtx.webServer.register(route), `tray-flash: ${route.path}`)
      }
      webCtx.logger?.info?.(`${LOG} self-test routes ${routes.map((route) => route.path).join(', ')}`)
    })
  }
}

/**
 * Map one Session log event onto the attention controller.
 *
 * @param attention - the controller.
 * @param session - emitting Session.
 * @param event - committed Session event.
 * @param mainSessionId - the session the main view retains, when known.
 */
function observe(attention, session, event, mainSessionId) {
  switch (event?.type) {
    case 'turn/end':
      attention.notifyTurnEnd(event, session, { isMain: isMainSession(session, mainSessionId) })
      return
    case 'approval/asked':
      attention.notifyApproval(session)
      return
    case 'tool/call':
      if (event.data?.name === QUESTION_TOOL) attention.notifyQuestion(session)
      return
    default:
      return
  }
}

/**
 * Whether a Session is the one the main view is showing.
 *
 * The Host has no direct view of Client retention, so this falls back to the
 * session the Client last named when it selected one. When nothing is known the
 * answer is `false`: a background session's real dot is the safer assumption,
 * because a wrong `true` would raise a virtual dot that only focus can clear.
 *
 * @param session - the emitting Session.
 * @param mainSessionId - last known main session id.
 * @returns true when this session should raise the virtual dot.
 */
function isMainSession(session, mainSessionId) {
  if (session?.id === undefined || mainSessionId === undefined) return false
  return session.id === mainSessionId
}

/**
 * Reduce an error to one short line.
 *
 * @param error - thrown value.
 * @returns a single-line description.
 */
function messageOf(error) {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
  return String(error)
}
