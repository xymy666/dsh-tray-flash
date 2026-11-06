/**
 * Tracks the attention dots the Client shows in its session list.
 *
 * The dots are computed in the browser — `uiSession.sessionStatus` derives them
 * from `pendingInteraction` (a yellow dot: an approval, a plan review or a
 * question is waiting) and `completionUnread` (a green dot: a background session
 * finished and nobody looked at it). The Host process cannot see either value, so
 * the Client half of this plugin reports them here and the flash is tied to them
 * instead of to window focus.
 *
 * Two facts from `dsh-client-ui-session` shape this module:
 *
 * - The **main** session is excluded from `completionUnread` on purpose
 *   (`!this.isMain(sessionId)` guards the insert), so it never produces a green
 *   dot. Without help, a main-session turn would start a flash that no dot can
 *   ever end. {@link createDots} therefore keeps a *virtual* unread flag for the
 *   main session, cleared when the window comes back to the foreground — the
 *   closest honest equivalent of "you have seen that turn".
 * - The Client can disappear (page reload, crashed renderer, DevTools open in a
 *   second tab). A report older than `staleSeconds` is treated as *unknown*
 *   rather than as *no dots*, so a dead Client degrades to focus-based stopping
 *   instead of a flash that never ends.
 *
 * @module dsh-tray-flash/dots
 */

/** The dot kinds a session row can show, in the order the Client displays them. */
export const DOT_KINDS = Object.freeze(['approval', 'question', 'unread'])

/** Report state: the Client is present and its counts are recent. */
const STATUS_LIVE = 'live'

/** Report state: nothing has arrived for longer than the staleness window. */
const STATUS_STALE = 'stale'

/** Report state: the Client has never reported since this Host started. */
const STATUS_ABSENT = 'absent'

/**
 * Coerce one reported count to a non-negative integer.
 *
 * @param value - raw value from the request body.
 * @returns the count, or 0 when the value is not a usable number.
 */
function countOf(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * Build the dot tracker.
 *
 * @param dependencies - the staleness window, an injectable clock and a logger.
 * @returns the tracker.
 */
export function createDots(dependencies = {}) {
  const {
    staleSeconds = 60,
    virtualMain = true,
    now = () => Date.now(),
    logger,
  } = dependencies

  /** Latest counts reported by the Client. */
  let counts = { approval: 0, question: 0, unread: 0 }
  /** When the last report arrived; `undefined` until the Client says anything. */
  let reportedAt
  /** Whether the Client has ever reported in this Host lifetime. */
  let everReported = false
  /** The main session's virtual unread flag. */
  let mainUnread = false
  /** The session id that owns the virtual flag, for the diagnostic log. */
  let mainSessionId
  /** The session the Client says its main view is showing. */
  let focusedSessionId
  let staleWarned = false

  /**
   * Whether the Client's last report is recent enough to act on.
   *
   * @returns true when a report arrived inside the staleness window.
   */
  function isLive() {
    if (reportedAt === undefined) return false
    return now() - reportedAt <= Math.max(1, staleSeconds) * 1000
  }

  /**
   * The tracker's current status, for diagnostics and for the stop rule.
   *
   * @returns one of {@link STATUS_LIVE}, {@link STATUS_STALE} or {@link STATUS_ABSENT}.
   */
  function status() {
    if (!everReported) return STATUS_ABSENT
    return isLive() ? STATUS_LIVE : STATUS_STALE
  }

  /**
   * Dots the Client is actually drawing, excluding the virtual main-session one.
   *
   * These are the yellow (approval/question) and green (unread) dots a person can
   * point at in the session list. They outrank every focus- or pointer-based stop
   * rule: the flash exists to last until this count reaches zero.
   *
   * @returns the number of real dots.
   */
  function realTotal() {
    return counts.approval + counts.question + counts.unread
  }

  /**
   * Total dots the user can currently see.
   *
   * The virtual main-session flag counts as one, so a main-session turn keeps the
   * flash alive the same way a background session's green dot does.
   *
   * @returns the number of dots.
   */
  function total() {
    return realTotal() + (mainUnread ? 1 : 0)
  }

  /**
   * Whether a real yellow/green dot is still showing.
   *
   * Follows the same staleness contract as {@link hasDots}: a Client that stopped
   * reporting answers `undefined` (unknown), never `false`, so a silent page
   * cannot fake "all clear".
   *
   * @returns true (dots remain), false (all clear), or undefined (unknown).
   */
  function hasRealDots() {
    if (!isLive()) return undefined
    return realTotal() > 0
  }

  /**
   * Whether anything still deserves attention.
   *
   * When the Client is not live this answers `undefined` — *unknown*, not
   * *clear* — so the caller can fall back to another rule instead of guessing.
   *
   * @returns true (dots remain), false (all clear), or undefined (unknown).
   */
  function hasDots() {
    if (!isLive()) return undefined
    return total() > 0
  }

  /**
   * Record a report from the Client.
   *
   * @param report - `{ counts }` from the request body.
   * @returns the tracked snapshot after the update.
   */
  function update(report) {
    const incoming = report?.counts ?? {}
    const next = {
      approval: countOf(incoming.approval),
      question: countOf(incoming.question),
      unread: countOf(incoming.unread),
    }
    // The Client also names the session its main view is showing. That is the
    // only way the Host learns which session is "main", and therefore which
    // finished turn should raise the virtual dot.
    if (typeof report?.mainSessionId === 'string' && report.mainSessionId.length > 0) {
      focusedSessionId = report.mainSessionId
    } else if (report?.mainSessionId === null) {
      focusedSessionId = undefined
    }
    const changed = DOT_KINDS.some((kind) => next[kind] !== counts[kind])
    counts = next
    reportedAt = now()
    everReported = true
    staleWarned = false
    if (changed) {
      logger?.debug?.(`tray-flash: dots approval=${String(next.approval)} question=${String(next.question)} unread=${String(next.unread)}`)
    }
    return snapshot()
  }

  /**
   * The session the Client's main view is showing, when it has said.
   *
   * @returns the session id, or undefined when unknown.
   */
  function currentSessionId() {
    return focusedSessionId
  }

  /**
   * Record that the main session finished a turn.
   *
   * Only the main session gets this treatment: background sessions already earn a
   * real green dot from the Client, so adding a virtual one would double-count.
   *
   * @param sessionId - the session that finished.
   * @param isMain - whether that session is the one the main view retains.
   * @returns true when the virtual flag was raised.
   */
  function noteTurnEnd(sessionId, isMain) {
    if (!virtualMain || isMain !== true) return false
    mainUnread = true
    mainSessionId = sessionId
    return true
  }

  /**
   * Clear the main session's virtual unread flag.
   *
   * Called when the Harness window comes to the foreground: a person looking at
   * the window has seen whatever that turn produced.
   *
   * @returns true when a flag was actually cleared.
   */
  function noteFocused() {
    if (!mainUnread) return false
    mainUnread = false
    mainSessionId = undefined
    return true
  }

  /**
   * Drop every dot, including the virtual one.
   *
   * Used by the Client's unload handler and by the self-test routes.
   */
  function clear() {
    counts = { approval: 0, question: 0, unread: 0 }
    mainUnread = false
    mainSessionId = undefined
    reportedAt = now()
    everReported = true
  }

  /**
   * Stop treating the Client as present, without discarding its last counts.
   *
   * A stale Client is *unknown*, and the caller falls back to focus-based
   * stopping; forgetting the counts entirely would make a recovered page look
   * like a fresh start and lose the dots it is about to render.
   */
  function invalidate() {
    reportedAt = undefined
  }

  /**
   * Log once when the Client goes stale.
   *
   * A page reload happens often enough that warning every poll would bury the
   * Host log, so this fires at most once per stale period.
   */
  function warnIfStale() {
    if (status() !== STATUS_STALE || staleWarned) return
    staleWarned = true
    logger?.warn?.('tray-flash: the Client stopped reporting dots; falling back to window focus')
  }

  /**
   * A snapshot for the diagnostic route.
   *
   * @returns the tracker state.
   */
  function snapshot() {
    return {
      status: status(),
      counts: { ...counts },
      realTotal: realTotal(),
      total: total(),
      virtualMainUnread: mainUnread,
      mainSessionId,
      currentSessionId: focusedSessionId,
      reportedAt,
    }
  }

  /**
   * Whether the main session has an unanswered virtual dot.
   *
   * @returns true when the flag is raised.
   */
  function mainPending() {
    return mainUnread
  }

  return {
    update,
    noteTurnEnd,
    noteFocused,
    clear,
    invalidate,
    warnIfStale,
    hasDots,
    hasRealDots,
    isLive,
    status,
    total,
    realTotal,
    mainPending,
    currentSessionId,
    snapshot,
  }
}

export { STATUS_ABSENT, STATUS_LIVE, STATUS_STALE }
