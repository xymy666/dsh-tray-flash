/**
 * Tray-icon flashing for the Windows notification area.
 *
 * Electron offers no way to animate a `Tray` from outside the application, but
 * the shell's notification area is addressable directly: the application's tray
 * icon is an ordinary `NOTIFYICONIDENTIFIER` (the Electron main process's
 * `Electron_NotifyIconHostWindow` plus a small id), and `Shell_NotifyIconW` with
 * `NIM_MODIFY` replaces its image in place. That is what makes the "QQ blink"
 * possible: alternate the shipped icon with a fully transparent one on a timer.
 *
 * Two properties of the application make this safe enough to ship:
 *
 * - `DesktopTray` only ever calls `setToolTip` and `setContextMenu` after
 *   construction, and neither touches the icon, so a swapped image is not
 *   overwritten by a locale change.
 * - The icon is looked up at runtime rather than cached by the shell, so a
 *   restart of the application always rebuilds it from `resources/tray.ico` —
 *   a crash cannot leave a permanently blank tray icon behind.
 *
 * The "off" half of the blink is a fully transparent ICO rather than a recoloured
 * glyph, which is how QQ looks: the icon disappears and comes back. A transparent
 * frame was measured to render as empty space and to keep the slot clickable, so
 * the icon stays usable while it is not visible.
 *
 * Everything is optional: when the tray host window or the icon file cannot be
 * found, {@link createTrayBlink} reports `available: false` and the caller keeps
 * flashing the taskbar button alone.
 *
 * @module dsh-tray-flash/tray
 */

/** `Shell_NotifyIconW` message: change an existing icon in place. */
const NIM_MODIFY = 1

/** `NOTIFYICONDATAW.uFlags` bit: the `hIcon` member is meaningful. */
const NIF_ICON = 0x2

/** `LoadImageW` type: an icon resource. */
const IMAGE_ICON = 1

/** `LoadImageW` flag: read the image from the file `name` points at. */
const LR_LOADFROMFILE = 0x10

/** Class name of the hidden window Electron uses to own tray icons. */
const TRAY_HOST_CLASS = 'Electron_NotifyIconHostWindow'

/**
 * Size of `NOTIFYICONDATAW` on x64 for this Windows version.
 *
 * The struct grew over releases; 976 is what this build accepts, and a wrong
 * `cbSize` makes every call fail with `ERROR_INVALID_PARAMETER` and no diagnosis.
 */
const NOTIFYICONDATAW_SIZE = 976

/** Size of `NOTIFYICONIDENTIFIER`, also versioned: 40 is the current layout. */
const NOTIFYICONIDENTIFIER_SIZE = 40

/** Highest icon id probed on the host window. */
const MAX_PROBED_UID = 16

/**
 * Locate the tray icon owned by one process.
 *
 * The id is not exposed anywhere, so it is discovered by asking the shell for the
 * screen rectangle of every candidate id: an id that answers with a rectangle is
 * in use, and one that returns `E_INVALIDARG` is not.
 *
 * @param trayHost - bound Win32 surface (see `createTrayPort`).
 * @returns `{ hwnd, uid }`, or `undefined` when this process owns no tray icon.
 */
export function findTrayIcon(trayHost) {
  for (const hwnd of trayHost.trayHostWindows()) {
    for (let uid = 0; uid <= MAX_PROBED_UID; uid += 1) {
      if (trayHost.rectOf(hwnd, uid) !== undefined) return { hwnd, uid }
    }
  }
  return undefined
}

/**
 * Bind the extra user32/shell32 entry points the tray needs.
 *
 * @param koffi - the loaded koffi module.
 * @param user32 - the already-loaded `user32.dll` surface.
 * @param shell32 - the loaded `shell32.dll` surface.
 * @param helpers - window enumeration and process id helpers from `win32.mjs`.
 * @returns the tray-specific surface.
 */
export function createTrayPort(koffi, user32, shell32, helpers) {
  const loadImageW = user32.func('void* __stdcall LoadImageW(void* inst, void* name, uint32 type, int cx, int cy, uint32 flags)')
  const destroyIcon = user32.func('bool __stdcall DestroyIcon(void* icon)')
  const shellNotifyIconW = shell32.func('bool __stdcall Shell_NotifyIconW(uint32 msg, void* data)')
  const shellNotifyIconGetRect = shell32.func('long __stdcall Shell_NotifyIconGetRect(void* id, void* rect)')

  /**
   * Enumerate the tray host windows owned by any of the given processes.
   *
   * @param pids - candidate process ids.
   * @returns the matching window handles, as bigints.
   */
  function trayHostWindows(pids) {
    return helpers
      .listWindowsFor(pids)
      .filter((window) => window.className === TRAY_HOST_CLASS)
      .map((window) => window.hwnd)
  }

  /**
   * Ask the shell where one tray icon is drawn.
   *
   * @param hwnd - tray host window.
   * @param uid - icon id on that window.
   * @returns the rectangle, or `undefined` when no icon has that id.
   */
  function rectOf(hwnd, uid) {
    const identifier = Buffer.alloc(NOTIFYICONIDENTIFIER_SIZE)
    identifier.writeUInt32LE(NOTIFYICONIDENTIFIER_SIZE, 0)
    identifier.writeBigUInt64LE(BigInt(hwnd), 8)
    identifier.writeUInt32LE(uid, 16)
    const rect = Buffer.alloc(16)
    if (shellNotifyIconGetRect(identifier, rect) !== 0) return undefined
    return {
      left: rect.readInt32LE(0),
      top: rect.readInt32LE(4),
      right: rect.readInt32LE(8),
      bottom: rect.readInt32LE(12),
    }
  }

  /**
   * Load one icon file.
   *
   * @param path - absolute `.ico` path.
   * @returns the icon handle, or `undefined` when the file cannot be loaded.
   */
  function loadIcon(path) {
    const name = Buffer.from(`${path}\0`, 'utf16le')
    const handle = loadImageW(null, name, IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
    return handle === null || handle === undefined ? undefined : handle
  }

  /**
   * Replace the image of one tray icon.
   *
   * Only `NIF_ICON` is set, so the tooltip and the click behaviour the
   * application installed stay exactly as they were.
   *
   * @param hwnd - tray host window.
   * @param uid - icon id.
   * @param icon - icon handle from {@link loadIcon}.
   * @returns true when the shell accepted the change.
   */
  function setIcon(hwnd, uid, icon) {
    const data = Buffer.alloc(NOTIFYICONDATAW_SIZE)
    data.writeUInt32LE(NOTIFYICONDATAW_SIZE, 0)
    data.writeBigUInt64LE(BigInt(hwnd), 8)
    data.writeUInt32LE(uid, 16)
    data.writeUInt32LE(NIF_ICON, 20)
    data.writeBigUInt64LE(BigInt(icon), 32)
    return Boolean(shellNotifyIconW(NIM_MODIFY, data))
  }

  /**
   * Release an icon handle.
   *
   * @param icon - handle from {@link loadIcon}.
   */
  function releaseIcon(icon) {
    if (icon !== undefined) destroyIcon(icon)
  }

  return { trayHostWindows, rectOf, loadIcon, setIcon, releaseIcon }
}

/**
 * Build the blinking tray controller.
 *
 * @param dependencies - tray port, the original icon path, the transparent icon
 *   path, the pids to search, the blink interval, and a logger.
 * @returns the controller.
 */
export function createTrayBlink(dependencies) {
  const {
    port,
    originalIconPath,
    blankIconPath,
    pids,
    intervalMs = 600,
    logger,
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (handle) => clearInterval(handle),
  } = dependencies

  /** Resolved tray identity, looked up once and reused. */
  let target
  /** Loaded icon handles, kept alive while they may be displayed. */
  let icons
  let timer
  let showingBlank = false
  /** Set once a lookup has definitively failed, so the log stays quiet. */
  let unavailable

  /**
   * Resolve the tray icon, loading both images the first time it is needed.
   *
   * @returns the identity plus the handles, or `undefined`.
   */
  function prepare() {
    if (target !== undefined && icons !== undefined) return target
    target = findTrayIcon({ trayHostWindows: () => port.trayHostWindows(pids), rectOf: port.rectOf })
    if (target === undefined) return undefined
    const normal = port.loadIcon(originalIconPath)
    const blank = port.loadIcon(blankIconPath)
    if (normal === undefined || blank === undefined) {
      if (normal !== undefined) port.releaseIcon(normal)
      if (blank !== undefined) port.releaseIcon(blank)
      return undefined
    }
    icons = { normal, blank }
    logger?.info?.(`tray-flash: tray icon found on window ${handleText(target.hwnd)} (id ${String(target.uid)})`)
    return target
  }

  /**
   * Show one of the two images.
   *
   * @param blank - true to show the empty frame.
   * @returns true when the shell accepted it.
   */
  function show(blank) {
    if (target === undefined || icons === undefined) return false
    const icon = blank ? icons.blank : icons.normal
    const ok = port.setIcon(target.hwnd, target.uid, icon)
    if (ok) showingBlank = blank
    return ok
  }

  /**
   * Perform one blink step: flip to the other image.
   */
  function tick() {
    show(!showingBlank)
  }

  /**
   * Start blinking. Safe to call while already blinking.
   *
   * @returns true when blinking actually started.
   */
  function start() {
    if (timer !== undefined) return true
    if (unavailable !== undefined) return false
    if (prepare() === undefined) {
      unavailable = true
      logger?.warn?.('tray-flash: no tray icon found for this process; taskbar flashing only')
      return false
    }
    if (!show(true)) {
      unavailable = true
      logger?.warn?.('tray-flash: the shell refused the tray icon change; taskbar flashing only')
      return false
    }
    timer = setIntervalFn(tick, Math.max(200, Math.trunc(intervalMs)))
    if (typeof timer?.unref === 'function') timer.unref()
    return true
  }

  /**
   * Stop blinking and put the application's own icon back.
   *
   * @returns true when the original image was restored.
   */
  function stop() {
    if (timer !== undefined) {
      clearIntervalFn(timer)
      timer = undefined
    }
    if (target === undefined || icons === undefined) return false
    return show(false)
  }

  /**
   * Release everything: stop blinking, restore the image, destroy the handles.
   */
  function dispose() {
    stop()
    if (icons !== undefined) {
      port.releaseIcon(icons.normal)
      port.releaseIcon(icons.blank)
      icons = undefined
    }
    target = undefined
  }

  return {
    start,
    stop,
    dispose,
    tick,
    snapshot() {
      return {
        available: unavailable === undefined && target !== undefined,
        blinking: timer !== undefined,
        showingBlank,
        target: target === undefined
          ? undefined
          : { hwnd: handleText(target.hwnd), uid: target.uid },
      }
    },
  }
}

/**
 * Render a window handle for a log line.
 *
 * @param hwnd - handle as bigint or number.
 * @returns hexadecimal text.
 */
function handleText(hwnd) {
  try {
    return `0x${BigInt(hwnd).toString(16)}`
  } catch {
    return String(hwnd)
  }
}
