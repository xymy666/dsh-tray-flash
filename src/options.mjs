/**
 * Configuration normalization.
 *
 * The plugin deliberately exports no `Config` schema: a schema would make it
 * depend on `@deepseek-ai/schemastery`, which a workspace-installed bundle
 * cannot resolve (proven with `koffi`: a `link:` package resolves only what it
 * ships). Instead every field is read here, validated against its documented
 * range, and reported once when a value had to be replaced — a bad row then
 * leaves the Host running with defaults instead of failing activation.
 *
 * @module dsh-tray-flash/options
 */

/** Defaults for every supported field. */
export const DEFAULTS = Object.freeze({
  /** Master switch. */
  enabled: true,
  /** Flash the title bar as well as the taskbar button. */
  flashCaption: true,
  /** Do nothing when the Harness window already has the foreground. */
  onlyWhenUnfocused: true,
  /**
   * Stop a flash that nobody answered after this many seconds (0 = never).
   *
   * The default is 0: the flash follows the attention dots, so it lasts until
   * they clear. A fixed cap made a dot that stayed up longer than the cap stop
   * notifying for good — nothing re-arms a flash whose dot count never changes,
   * so the reminder was simply lost. Set a positive value to add a safety limit.
   */
  maxFlashSeconds: 0,
  /** Skip turns that were interrupted, aborted or cancelled. */
  ignoreInterrupted: true,
  /** Skip sessions owned by a sub-agent or forked from another session. */
  ignoreSubagent: true,
  /** `dwTimeout` handed to FlashWindowEx, in milliseconds. */
  flashTimeout: 0,
  /** `uCount` handed to FlashWindowEx; 0 keeps flashing until the foreground. */
  flashCount: 0,
  /** Foreground/liveness poll interval, clamped by `clampInterval`. */
  pollIntervalMs: 1000,
  /** Register the loopback self-test route. */
  allowTestFlash: true,
  /**
   * Blink the notification-area icon as well as the taskbar button.
   *
   * The blink hides the icon and brings it back, like QQ: the tray slot goes empty
   * and returns rather than changing colour.
   */
  trayBlink: true,
  /** Half-period of the tray blink, in milliseconds. */
  trayBlinkIntervalMs: 600,
  /**
   * Keep flashing until every attention dot is gone.
   *
   * With this on, focus does not end a flash while a dot is still showing: a
   * background session's green dot or a waiting approval keeps it running. It is
   * the rule this plugin exists for and the one the user asked for.
   */
  stopWhenDotsClear: true,
  /**
   * Give the main session a virtual unread dot.
   *
   * The Client deliberately never marks the main session unread, so without this
   * a main-session turn would start a flash no dot could ever end. The virtual dot
   * clears when the window returns to the foreground.
   */
  virtualMainDot: true,
  /** How long a Client dot report stays trusted, in seconds. */
  dotsStaleSeconds: 60,
})

/** Numeric fields and the bounds each accepts. */
const NUMERIC = {
  maxFlashSeconds: { min: 0, max: 86_400 },
  flashTimeout: { min: 0, max: 60_000 },
  flashCount: { min: 0, max: 100_000 },
  pollIntervalMs: { min: 200, max: 5000 },
  trayBlinkIntervalMs: { min: 100, max: 5000 },
  dotsStaleSeconds: { min: 5, max: 3600 },
}

/** Boolean fields. */
const BOOLEAN = [
  'enabled',
  'flashCaption',
  'onlyWhenUnfocused',
  'ignoreInterrupted',
  'ignoreSubagent',
  'allowTestFlash',
  'trayBlink',
  'stopWhenDotsClear',
  'virtualMainDot',
]

/**
 * Normalize one row's config.
 *
 * @param input - the `config` object from the Cordis patch row, possibly absent.
 * @returns the resolved options plus the human-readable problems found.
 */
export function resolveOptions(input) {
  const problems = []
  const resolved = { ...DEFAULTS }

  if (input === undefined || input === null) return { options: resolved, problems }
  if (typeof input !== 'object' || Array.isArray(input)) {
    problems.push(`config must be a mapping, got ${Array.isArray(input) ? 'array' : typeof input}`)
    return { options: resolved, problems }
  }

  for (const [key, value] of Object.entries(input)) {
    if (BOOLEAN.includes(key)) {
      if (typeof value === 'boolean') resolved[key] = value
      else problems.push(`${key} must be a boolean, got ${typeOf(value)}; using ${String(DEFAULTS[key])}`)
      continue
    }
    if (Object.hasOwn(NUMERIC, key)) {
      const { min, max } = NUMERIC[key]
      if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
        resolved[key] = value
      } else {
        problems.push(`${key} must be an integer in [${min}, ${max}], got ${typeOf(value)}; using ${String(DEFAULTS[key])}`)
      }
      continue
    }
    problems.push(`unknown option ${JSON.stringify(key)} (ignored)`)
  }

  return { options: resolved, problems }
}

/**
 * Name a JavaScript value's type the way a person reads it.
 *
 * @param value - any value.
 * @returns a short type name.
 */
function typeOf(value) {
  if (value === null) return 'null'
  if (typeof value === 'number' && Number.isInteger(value)) return `integer ${String(value)}`
  if (typeof value === 'number') return `number ${String(value)}`
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`
  return typeof value
}
