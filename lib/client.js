/**
 * Client half of `dsh-tray-flash`: report the attention dots to the Host.
 *
 * The dots in the session list are computed here, in the browser, not in the Host
 * process. `uiSession.sessionStatus` already derives them for the sidebar, so this
 * half only has to count them and tell the Host, which owns the tray icon and the
 * taskbar flash.
 *
 * ```
 * pendingInteraction → yellow dot (an approval, a plan review or a question)
 * completionUnread   → green dot  (a background session finished, unread)
 * ```
 *
 * The flash ends when both counts reach zero, so the report is the plugin's whole
 * contract with the Host: a handful of integers, on every change.
 *
 * ## Why a hand-written bundle
 *
 * This package ships no bundler step, and DSH loads a client half by evaluating
 * `lib/client.js` in the page, where it must call `window.__ModuleLoader__.load`
 * and register itself under the package name. That is the same shape the shipped
 * and third-party client plugins use, so it is written out literally here instead
 * of being generated.
 *
 * ## Failure behaviour
 *
 * Every request is best-effort: a failed POST leaves the Host on its focus
 * fallback rather than throwing into the page. The Host treats a silent Client as
 * *unknown*, never as *all clear*, so losing this half cannot produce a flash that
 * never ends.
 *
 * @module dsh-tray-flash/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-tray-flash',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Route the Host listens on for dot reports. */
    const DOTS_PATH = '/__tray-flash/dots'

    /** Minimum gap between two reports, so a busy session list cannot flood the Host. */
    const THROTTLE_MS = 250

    /**
     * Count the dots the sidebar is currently showing.
     *
     * `pendingInteraction` covers the yellow dot; `completionUnread` covers the
     * green one. Anything else the Client may add later is ignored rather than
     * guessed at.
     *
     * @param statuses - the `uiSession.sessionStatus` snapshot, a Map of id to status.
     * @returns the counts plus their total.
     */
    function countDots(statuses) {
      const counts = { approval: 0, question: 0, unread: 0 }
      if (statuses === undefined || statuses === null) return { ...counts, total: 0 }
      const rows = typeof statuses.values === 'function' ? [...statuses.values()] : Object.values(statuses)
      for (const status of rows) {
        if (status === undefined || status === null) continue
        if (status.completionUnread === true) counts.unread += 1
        const kind = status.pendingInteraction?.kind
        if (kind === 'approval') counts.approval += 1
        else if (kind === 'question' || kind === 'plan-review') counts.question += 1
      }
      return { ...counts, total: counts.approval + counts.question + counts.unread }
    }

    /**
     * Post one report to the Host.
     *
     * @param payload - `{ counts }` to send.
     * @returns a promise that never rejects.
     */
    async function report(payload) {
      try {
        await fetch(DOTS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Same-origin relative path: the Host's fence requires loopback and a
          // loopback Host header, which a relative request satisfies by default.
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        })
      } catch {
        // The Host may be restarting, or this page may be closing. The Host's
        // staleness window covers the gap; there is nothing useful to do here.
      }
    }

    /**
     * Tell the Host the dots are gone, sent when this half unloads.
     *
     * A `keepalive` request survives the page being torn down, which is the only
     * moment this matters.
     *
     * @returns nothing.
     */
    function clearOnUnload() {
      try {
        fetch(DOTS_PATH, { method: 'DELETE', credentials: 'same-origin', keepalive: true })
      } catch {
        // Nothing to do: the Host's staleness window also covers this case.
      }
    }

    /**
     * Find the session the main view is showing.
     *
     * `uiSession.current` carries the binding the main pane renders; its key is
     * the session id. When it is absent the Host falls back to treating finished
     * turns as background ones, which is the safe direction: a background session
     * always earns a real dot, so the flash can still end.
     *
     * @param uiSession - the client `uiSession` service.
     * @returns the session id, or undefined when the main pane is empty.
     */
    function currentSessionId(uiSession) {
      try {
        const current = uiSession?.current?.getSnapshot?.()
        const key = current?.key ?? current?.sessionId
        return typeof key === 'string' && key.length > 0 ? key : undefined
      } catch {
        return undefined
      }
    }

    /**
     * How often a report is sent even when nothing changed, in milliseconds.
     *
     * The Host treats silence as "the Client is gone" after `dotsStaleSeconds`
     * (60s by default) and falls back to its focus rule. A dot that stays up
     * without changing — the common case, since a person may not look for a
     * while — would otherwise age into that stale state and stop the flash. This
     * beat is what keeps "no change" from being read as "no Client".
     */
    const HEARTBEAT_MS = 30_000

    const inject = ['uiSession']

    /**
     * Subscribe to the dot status and forward every change.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const source = ctx.uiSession?.sessionStatus
        if (source === undefined || typeof source.subscribe !== 'function') {
          console.warn('[tray-flash] uiSession.sessionStatus is unavailable; the Host keeps its focus fallback')
          return () => {}
        }

        /** The last total that was sent, so an unchanged report is skipped. */
        let lastTotal
        /** The last main session id sent, so a switch is reported too. */
        let lastMain
        /** Timer handle for a throttled trailing report. */
        let pending
        /** Timer handle for the keep-alive beat. */
        let heartbeat

        /**
         * Send the current counts.
         *
         * Two facts matter to the Host: how many dots are showing (it keeps the
         * flash alive while they are non-zero) and which session is main (it uses
         * that to decide whether a finished turn raises a virtual dot).
         *
         * @param force - send even when nothing changed, for the heartbeat.
         */
        const flush = (force = false) => {
          pending = undefined
          const counted = countDots(source.getSnapshot())
          const main = currentSessionId(ctx.uiSession)
          if (!force && counted.total === lastTotal && main === lastMain) return
          lastTotal = counted.total
          lastMain = main
          report({
            counts: { approval: counted.approval, question: counted.question, unread: counted.unread },
            mainSessionId: main ?? null,
          })
        }

        /** Coalesce a burst of changes into at most one report per window. */
        const schedule = () => {
          if (pending !== undefined) return
          pending = setTimeout(flush, THROTTLE_MS)
        }

        const unsubscribe = source.subscribe(schedule)
        // The main pane switching sessions changes which turn counts as "main".
        const disposers = [unsubscribe]
        const currentSource = ctx.uiSession?.current
        if (currentSource !== undefined && typeof currentSource.subscribe === 'function') {
          disposers.push(currentSource.subscribe(schedule))
        }

        // Report once on mount: the page may have reloaded with dots already up.
        flush()

        // Keep the Host's staleness window from expiring while a dot simply sits
        // there unchanged.
        heartbeat = setInterval(() => flush(true), HEARTBEAT_MS)
        if (typeof heartbeat?.unref === 'function') heartbeat.unref()

        return () => {
          if (pending !== undefined) clearTimeout(pending)
          pending = undefined
          if (heartbeat !== undefined) clearInterval(heartbeat)
          heartbeat = undefined
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // A disposed store is not an error worth surfacing.
            }
          }
          clearOnUnload()
        }
      }, 'tray-flash: dot reports')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
