/**
 * The attention state machine: when to start flashing, when to stop.
 *
 * This module owns every decision and no I/O. It is handed a window port
 * (see `win32.mjs`), a clock, and a timer factory, which is what lets the whole
 * policy — deduplication, the stop rule, the deadline, the interrupt filter —
 * be tested without a real screen.
 *
 * The lifecycle is deliberately one-way: the first qualifying event starts a
 * flash, later events join the same flash instead of restarting it, and one
 * condition ends it.
 *
 * ## The stop rule
 *
 * The flash is tied to the **attention dots** the Client draws in its session
 * list, not to window focus. A yellow dot means an approval, a plan review or a
 * question is waiting; a green dot means a background session finished and
 * nobody looked. The flash lasts until no dot is left:
 *
 * - The main session never earns a real green dot, so it raises a *virtual* one
 *   that clears when the window comes back to the foreground.
 * - When the Client cannot be reached (never loaded, or silent past the staleness
 *   window), the dots are *unknown*, and the rule falls back to focus so a
 *   missing Client cannot produce a flash that never ends.
 *
 * @module dsh-tray-flash/attention
 */

/** Kinds of attention this plugin reacts to. */
export const SOURCE = {
  /** A turn finished: the answer is ready and nobody has read it. */
  turnEnd: 'turn-end',
  /** A tool is blocked on a human approval decision. */
  approval: 'approval',
  /** The model asked a question, including a plan submitted for review. */
  question: 'question',
}

/** Why a running flash was cancelled. */
export const STOP = {
  /** The dots cleared: everything that wanted attention has been seen. */
  dotsCleared: 'dots-cleared',
  /** Fell back to focus because the Client's dot report is not available. */
  focused: 'focused',
  /** The pointer moved, which is how a focused attempt is acknowledged. */
  mouseMoved: 'mouse-moved',
  /** The person switched to another session, so this one has been seen. */
  sessionSwitched: 'session-switched',
  /** The window stopped being the foreground one while awaiting a mouse move. */
  blurred: 'blurred',
  windowGone: 'window-gone',
  timeout: 'timeout',
  disabled: 'disabled',
  disposed: 'disposed',
  stopped: 'stopped',
}

/**
 * Human-readable explanations for the log, one line each.
 *
 * @param event - a `session/event` payload's type and data.
 * @returns true when the turn ended in a way the user should be told about.
 */
function isNoteworthyTurnEnd(event, options) {
  if (event?.type !== 'turn/end') return false
  const kind = event.data?.reason?.kind
  if (kind === undefined) return true
  if (kind === 'interrupted' || kind === 'aborted' || kind === 'cancelled') {
    return options.ignoreInterrupted !== true
  }
  return true
}

/**
 * Decide whether one session may raise attention at all.
 *
 * Sub-agent sessions are excluded by default because their turns end constantly
 * and the parent turn is the event a person actually waits for.
 *
 * @param session - the Session that emitted the event.
 * @param options - resolved plugin options.
 * @returns true when this session is allowed to raise attention.
 */
function isWatchedSession(session, options) {
  if (options.ignoreSubagent !== true) return true
  const header = session?.header
  if (header === undefined || header === null) return true
  if (header.origin === 'subagent') return false
  if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return false
  return true
}

/**
 * Build the attention controller.
 *
 * @param dependencies - window port, options, and injectable clock/timer/logger.
 * @returns the controller.
 */
export function createAttention(dependencies) {
  const {
    port,
    options,
    pids,
    logger,
    tray,
    dots,
    now = () => Date.now(),
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (handle) => clearInterval(handle),
  } = dependencies

  /** Sessions/approvals that arrived while nobody was looking. */
  const pending = new Set()
  /** Reasons collected since the flash started, for the diagnostic log. */
  let reasons = []
  let timer
  let hwnd
  let startedAt
  let deadlineAt
  let lastStop
  let disposed = false
  /**
   * Whether this flash is waiting on a mouse move rather than on the dots.
   *
   * Set when the turn that triggered the flash belongs to the session already on
   * screen *and* the window already has the foreground: there is no dot to wait
   * for in that case (the main session never earns one), yet the answer is still
   * worth announcing. The pointer becomes the "I have seen it" signal instead of
   * focus, so the flash does not end in the same tick it began.
   */
  let awaitingMouse = false
  /** Pointer position when the flash started, for the move comparison. */
  let cursorAtStart
  /** Session that was on screen when the flash started, for switch detection. */
  let sessionAtStart

  /**
   * Resolve the Harness window, trying each candidate process id in order.
   *
   * @returns the window descriptor, or `undefined` when none is visible yet.
   */
  function resolveWindow() {
    if (hwnd !== undefined && port.isLive(hwnd)) return { hwnd }
    hwnd = undefined
    for (const pid of pids) {
      const found = port.findMainWindow(pid)
      if (found !== undefined) {
        hwnd = found.hwnd
        return found
      }
    }
    return undefined
  }

  /**
   * Cancel the running flash and forget the pending reasons.
   *
   * @param cause - one of {@link STOP}.
   * @returns the stop cause.
   */
  function stopFlashing(cause) {
    if (timer !== undefined) {
      clearIntervalFn(timer)
      timer = undefined
    }
    const target = hwnd
    pending.clear()
    startedAt = undefined
    deadlineAt = undefined
    awaitingMouse = false
    cursorAtStart = undefined
    sessionAtStart = undefined
    if (target !== undefined) {
      try {
        port.stop(target)
      } catch (error) {
        logger?.warn?.(`tray-flash: stop failed: ${describe(error)}`)
      }
    }
    // The tray image is restored on every stop path, so a blink can never be
    // left running by a thrown error or a closed window.
    try {
      tray?.stop()
    } catch (error) {
      logger?.warn?.(`tray-flash: tray restore failed: ${describe(error)}`)
    }
    lastStop = cause
    return cause
  }

  /**
   * Evaluate the conditions that end a flash without an outside event.
   *
   * Runs on the interval rather than on a focus hook because the OS gives a
   * process no callback when another window takes the foreground, and the dot
   * counts arrive asynchronously over HTTP.
   *
   * The primary rule is "keep flashing while a dot remains". Focus is only the
   * fallback: it applies when the dots are *unknown* (no Client, or a Client that
   * stopped reporting), and it also clears the main session's virtual dot, which
   * is how a person acknowledging a main-session turn answers it.
   */
  function tick() {
    if (disposed) return
    if (hwnd === undefined) {
      stopFlashing(STOP.windowGone)
      return
    }
    if (!port.isLive(hwnd)) {
      stopFlashing(STOP.windowGone)
      return
    }

    // Waiting on the pointer: this flash was raised by the session already on
    // screen, so focus alone is not the acknowledgement — the person may be
    // reading the answer without having touched anything. The pointer moving,
    // switching session, or leaving the window ends it.
    if (awaitingMouse) {
      if (!port.isForeground(hwnd)) {
        stopFlashing(STOP.blurred)
        return
      }
      const current = dots?.currentSessionId?.()
      if (sessionAtStart !== undefined && current !== undefined && current !== sessionAtStart) {
        stopFlashing(STOP.sessionSwitched)
        return
      }
      if (port.cursorMoved?.(cursorAtStart, port.cursorPosition?.()) === true) {
        stopFlashing(STOP.mouseMoved)
        return
      }
      if (deadlineAt !== undefined && now() >= deadlineAt) {
        stopFlashing(STOP.timeout)
      }
      return
    }

    // A person looking at the window has seen whatever the main session produced,
    // so that virtual dot is answered by focus rather than by a Client report.
    // This runs *before* the dot check on purpose: clearing the virtual dot first
    // means a main-session turn cannot be cancelled in the same tick that started
    // it, and a real dot from a background session keeps the flash alive anyway.
    if (port.isForeground(hwnd)) dots?.noteFocused?.()
    dots?.warnIfStale?.()

    if (dots !== undefined && options.stopWhenDotsClear === true) {
      const remaining = dots.hasDots()
      if (remaining === false) {
        stopFlashing(STOP.dotsCleared)
        return
      }
      if (remaining === undefined) {
        // Unknown: the Client is not answering. Fall back to focus so a broken
        // page cannot leave a flash running until the deadline.
        if (port.isForeground(hwnd)) {
          stopFlashing(STOP.focused)
          return
        }
      }
      // remaining === true: dots are still showing, keep flashing.
    } else if (options.onlyWhenUnfocused === true && port.isForeground(hwnd)) {
      stopFlashing(STOP.focused)
      return
    }

    if (deadlineAt !== undefined && now() >= deadlineAt) {
      stopFlashing(STOP.timeout)
    }
  }

  /**
   * Start a flash for one window, if the current conditions allow it.
   *
   * This is the shared tail of {@link notify} and {@link evaluate}: one place that
   * decides whether to begin, so the event path and the dot path cannot drift
   * apart. It assumes the caller has already resolved the window.
   *
   * @param window - the window descriptor from `resolveWindow`.
   * @param kind - what triggered this, for the log and the diagnostic snapshot.
   * @returns a result describing the decision.
   */
  function startFlash(window, kind) {
    reasons = [kind]
    startedAt = now()
    deadlineAt = options.maxFlashSeconds > 0
      ? startedAt + options.maxFlashSeconds * 1000
      : undefined

    // Decide whether focus alone can acknowledge this flash.
    //
    // It cannot when the window is already in front and the flash belongs to the
    // session on screen: the answer appeared in a conversation the person is
    // already looking at, so "the window is focused" was true *before* the turn
    // finished and says nothing about whether the result was seen. Waiting for
    // the pointer is the distinction between "the window happens to be open" and
    // "a human moved".
    const wantsMouse = options.flashUntilMouseMoves === true
      && kind !== 'self-test'
      && port.isForeground(window.hwnd)

    // Without a readable pointer position there is nothing to compare against.
    // Falling back to the ordinary dot/focus rule is the only safe option; an
    // armed wait on an unreadable pointer would flash until the deadline.
    cursorAtStart = wantsMouse ? port.cursorPosition?.() : undefined
    awaitingMouse = wantsMouse && cursorAtStart !== undefined
    sessionAtStart = awaitingMouse ? dots?.currentSessionId?.() : undefined

    let raw
    try {
      raw = port.flash(window.hwnd, {
        caption: options.flashCaption === true,
        count: options.flashCount,
        timeout: options.flashTimeout,
      })
    } catch (error) {
      hwnd = undefined
      awaitingMouse = false
      return { started: false, reason: 'flash-failed', error: describe(error) }
    }

    timer = setIntervalFn(tick, clampInterval(options.pollIntervalMs))
    if (typeof timer?.unref === 'function') timer.unref()
    // The tray blink is started from the same decision, so both halves of the
    // "look at me" signal are driven by one state machine and stop together.
    // A tray that cannot be reached degrades to the taskbar flash alone.
    let trayStarted = false
    if (options.trayBlink === true && tray !== undefined) {
      try {
        trayStarted = tray.start()
      } catch (error) {
        logger?.warn?.(`tray-flash: tray blink failed: ${describe(error)}`)
      }
    }
    logger?.info?.(`tray-flash: started ${kind ?? 'attention'} on window ${handleText(window.hwnd)} (raw=${String(raw)}, tray=${trayStarted ? 'on' : 'off'}, dots=${String(dots?.total?.() ?? 'n/a')})`)
    return { started: true, hwnd: window.hwnd, raw, tray: trayStarted, pending: pending.size }
  }

  /**
   * Decide whether the current dot state justifies a flash, and start one.
   *
   * This is what makes a dot that appears *after* the turn ended still notify.
   * The Client computes its dots asynchronously — a green dot for a background
   * session is only added once that session's row stops running, which is after
   * `turn/end` was handled — so relying on the event alone missed it entirely.
   *
   * @param kind - what triggered this evaluation, for the log.
   * @returns a result describing the decision.
   */
  function evaluate(kind) {
    if (disposed) return { started: false, reason: 'disposed' }
    if (options.enabled !== true) return { started: false, reason: 'disabled' }
    if (port === undefined) return { started: false, reason: 'no-ffi' }
    if (timer !== undefined) return { started: false, reason: 'already-flashing' }

    const window = resolveWindow()
    if (window === undefined) return { started: false, reason: 'no-window' }

    if (options.stopWhenDotsClear === true && dots !== undefined) {
      const remaining = dots.hasDots()
      if (remaining === false) {
        return { started: false, reason: 'no-dots', hwnd: window.hwnd }
      }
      // A dot is showing, which is exactly the case that must notify even when
      // the window already has the foreground: the point of a dot is "you have
      // not looked at this yet", and looking at the taskbar is not looking at it.
      if (remaining === true) return startFlash(window, kind)
      // Unknown: fall back to the focus rule.
      if (options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
        return { started: false, reason: 'focused', hwnd: window.hwnd }
      }
      return { started: false, reason: 'unknown-dots', hwnd: window.hwnd }
    }

    if (options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
      return { started: false, reason: 'focused', hwnd: window.hwnd }
    }
    return startFlash(window, kind)
  }

  /**
   * Raise attention for one event.
   *
   * @param request - what happened and which session it came from.
   * @returns a result describing the decision, for tests and the diagnostic log.
   */
  function notify(request) {
    const kind = request?.kind
    const sessionId = request?.sessionId
    if (disposed) return { started: false, reason: 'disposed' }
    if (options.enabled !== true) return { started: false, reason: 'disabled' }
    if (port === undefined) return { started: false, reason: 'no-ffi' }
    if (request?.session !== undefined && !isWatchedSession(request.session, options)) {
      return { started: false, reason: 'ignored-session' }
    }

    const alreadyFlashing = timer !== undefined
    if (sessionId !== undefined) pending.add(sessionId)

    // A main-session turn produces no real dot, so it raises the virtual one.
    // Background sessions are left alone: the Client draws their dot itself, and
    // a second one here would keep the flash alive after the real dot cleared.
    const virtualRaised = dots?.noteTurnEnd?.(sessionId, request?.isMain === true) === true

    const window = resolveWindow()
    if (window === undefined) {
      return { started: false, reason: 'no-window', pending: pending.size }
    }
    // The dots decide whether this event is worth a flash. The main session's
    // virtual dot counts, so a focused main-session turn still notifies.
    if (options.stopWhenDotsClear === true && dots !== undefined) {
      const remaining = dots.hasDots()
      if (remaining === false && virtualRaised !== true) {
        return { started: false, reason: 'no-dots', hwnd: window.hwnd, pending: pending.size }
      }
      if (remaining === undefined && options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
        return { started: false, reason: 'focused', hwnd: window.hwnd, pending: pending.size }
      }
    } else if (options.onlyWhenUnfocused === true && port.isForeground(window.hwnd)) {
      return { started: false, reason: 'focused', hwnd: window.hwnd, pending: pending.size }
    }
    if (alreadyFlashing) {
      reasons.push(kind)
      return { started: false, reason: 'already-flashing', hwnd: window.hwnd, pending: pending.size }
    }

    return startFlash(window, kind)
  }

  /**
   * Manually stop a flash, used by the self-test route and by disposal.
   *
   * @param cause - stop reason to record.
   * @returns the recorded cause.
   */
  function stop(cause = STOP.stopped) {
    return stopFlashing(cause)
  }

  /** Release the timer and the tray icons; later calls become no-ops. */
  function dispose() {
    if (disposed) return
    if (timer !== undefined) stopFlashing(STOP.disposed)
    // `stopFlashing` restores the image but keeps the handles; a disposed
    // controller will never blink again, so they are released here.
    try {
      tray?.dispose()
    } catch (error) {
      logger?.warn?.(`tray-flash: tray cleanup failed: ${describe(error)}`)
    }
    disposed = true
  }

  return {
    notify,
    notifyTurnEnd(event, session, context) {
      if (!isNoteworthyTurnEnd(event, options)) {
        return { started: false, reason: 'ignored-interrupted' }
      }
      return notify({
        kind: SOURCE.turnEnd,
        session,
        sessionId: session?.id,
        isMain: context?.isMain === true,
        event,
      })
    },
    notifyApproval(session) {
      return notify({ kind: SOURCE.approval, session, sessionId: session?.id })
    },
    notifyQuestion(session) {
      return notify({ kind: SOURCE.question, session, sessionId: session?.id })
    },
    /**
     * Forward a dot report from the Client half, and start a flash if that report
     * is the first thing to say one is needed.
     *
     * This is the fix for a real failure: the Client computes a green dot for a
     * background session only after that session's row stops running, which is
     * *later* than the `turn/end` event that session produced. Handling only the
     * event meant the flash was evaluated while no dot existed yet, and the dot
     * that appeared moments afterwards was never acted on — the tray stayed still
     * while the sidebar showed a dot.
     *
     * A dot that merely grows while a flash is already running is ignored here;
     * the running flash already covers it, and restarting would reset its timer.
     */
    updateDots(report) {
      const snapshot = dots?.update?.(report)
      const after = dots?.total?.() ?? 0
      // Start whenever there is something to show and nothing is showing it.
      //
      // A growth test alone missed a real case: once a flash has stopped, its dot
      // is still counted (the virtual main dot is only cleared by focus), so the
      // next turn on the same session leaves the total unchanged and the new
      // answer would never be announced. "Any dot, no flash running" covers both
      // that and a dot that appears without changing the total.
      if (timer === undefined && after > 0) evaluate('dots')
      return snapshot
    },
    /** Clear every dot, used by the Client's unload handler and the self-test. */
    clearDots() {
      dots?.clear?.()
    },
    tick,
    stop,
    dispose,
    snapshot() {
      return {
        flashing: timer !== undefined,
        pending: [...pending],
        reasons: [...reasons],
        hwnd,
        startedAt,
        deadlineAt,
        lastStop,
        disposed,
        tray: tray?.snapshot?.(),
        dots: dots?.snapshot?.(),
      }
    },
  }
}

/**
 * Keep the poll interval inside a range that cannot pin a core or stall the stop.
 *
 * @param value - configured interval in milliseconds.
 * @returns the clamped interval.
 */
export function clampInterval(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1000
  return Math.min(5000, Math.max(200, Math.trunc(number)))
}

/**
 * Render a window handle for a log line.
 *
 * @param hwnd - handle as bigint or number.
 * @returns hexadecimal text.
 */
export function handleText(hwnd) {
  try {
    return `0x${BigInt(hwnd).toString(16)}`
  } catch {
    return String(hwnd)
  }
}

/**
 * Reduce an error to one short line.
 *
 * @param error - thrown value.
 * @returns a single-line description.
 */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0] ?? ''}`
  return String(error)
}

export { isNoteworthyTurnEnd, isWatchedSession }
