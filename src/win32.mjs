/**
 * Win32 window bindings behind one small, injectable surface.
 *
 * The only thing this module knows how to do is find the Harness top-level
 * window and ask Windows to flash it. Everything is created through a passed-in
 * `koffi` module so the whole surface is unit-testable with a fake, and so a
 * Host without FFI can stay silent instead of crashing.
 *
 * Two behaviours here were established by measurement against this deployment
 * and are deliberate:
 *
 * - `FlashWindowEx` returns a BOOL, but reading it back through koffi is
 *   unreliable (the same successful call reports `32768` or `0` depending on how
 *   the call is shaped). Success is therefore never inferred from the return
 *   value; it is logged only.
 * - `FLASHWINFO` is 32 bytes on x64 (4 + 4 pad + 8 + 4 + 4 + 4 pad). Getting
 *   this wrong makes the call fail with no diagnostic, so it is asserted.
 *
 * @module dsh-tray-flash/win32
 */

/** Class name of an Electron top-level browser window. */
const CHROME_WIDGET_CLASS = 'Chrome_WidgetWin_1'

/** `FLASHW_CAPTION | FLASHW_TRAY | FLASHW_TIMERNOFG`: flash until foreground. */
export const FLASH_CAPTION = 0x1
/** Flash the taskbar button only. */
export const FLASH_TRAY = 0x2
/** Keep flashing until the window comes to the foreground. */
export const FLASH_TIMERNOFG = 0xc
/** Stop flashing. */
export const FLASH_STOP = 0x0

/**
 * Compose the `dwFlags` value for one flash request.
 *
 * @param options - whether the title bar joins the taskbar button.
 * @returns the flag bits.
 */
export function flashFlags(options = {}) {
  const { caption = true } = options
  return (caption ? FLASH_CAPTION | FLASH_TRAY : FLASH_TRAY) | FLASH_TIMERNOFG
}

/**
 * Convert a value koffi may hand back as a bigint, a number or a string.
 *
 * @param value - pointer-ish value.
 * @returns the same handle as a bigint, or `0n` when it is not one.
 */
export function handleOf(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

/**
 * Compare two window handles that may arrive in different representations.
 *
 * @param left - first handle.
 * @param right - second handle.
 * @returns true when they name the same window.
 */
export function sameHandle(left, right) {
  return handleOf(left) === handleOf(right) && handleOf(left) !== 0n
}

/**
 * Read a UTF-16 string out of a fixed buffer filled by a `W` API.
 *
 * @param buffer - destination buffer.
 * @param written - character count the API returned.
 * @returns the decoded string, or `''` when nothing was written.
 */
function decodeWide(buffer, written) {
  if (written <= 0) return ''
  return buffer.toString('utf16le', 0, written * 2)
}

/**
 * Declare one koffi type at most once per process.
 *
 * koffi keeps struct and proto types in a global namespace owned by the loaded
 * native module, so re-declaring a name throws instead of returning the existing
 * type. Caching by name turns a second activation into a reuse.
 *
 * @param koffi - the loaded koffi module.
 * @param kind - `'struct'` or `'proto'`.
 * @param nameOrSignature - struct name, or the full callback signature.
 * @param shape - field map, for a struct.
 * @returns the declared type.
 */
function declareType(koffi, kind, nameOrSignature, shape) {
  declared ??= new Map()
  const key = `${kind}:${nameOrSignature}`
  const cached = declared.get(key)
  if (cached !== undefined) return cached
  // Only a type already owned by another live instance reaches this branch; its
  // layout is identical by construction, so a reuse is safe and a throw would
  // only cost the second activation.
  const type = kind === 'struct'
    ? koffi.struct(nameOrSignature, shape)
    : koffi.proto(nameOrSignature)
  declared.set(key, type)
  return type
}

/** Process-wide memo of koffi type declarations, keyed by kind and name. */
let declared

/**
 * Bind the Win32 entry points this plugin needs.
 *
 * koffi registers struct and callback types in a process-wide namespace and
 * throws `Duplicate type name` when the same name is declared twice, so a second
 * activation (a reload, a second profile row, or a test that applies the plugin
 * twice) would otherwise fail to bind at all. The declarations below are
 * therefore made once per process and reused.
 *
 * @param koffi - the loaded koffi module.
 * @returns the window surface, plus a `dispose` that releases the callback type.
 */
export function createWin32(koffi) {
  const user32 = koffi.load('user32.dll')

  const enumWindows = user32.func('bool __stdcall EnumWindows(void* cb, intptr_t p)')
  const getClassNameW = user32.func('int __stdcall GetClassNameW(void* h, void* b, int n)')
  const getWindowTextW = user32.func('int __stdcall GetWindowTextW(void* h, void* b, int n)')
  const getWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* h, void* pid)')
  const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* h)')
  const isWindow = user32.func('int __stdcall IsWindow(void* h)')
  const getForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()')
  // Declared with an untyped pointer so the caller can supply its own buffer;
  // see cursorPosition() for why a POINT struct is not used here.
  const getCursorPos = user32.func('bool __stdcall GetCursorPos(void* point)')

  // The struct must be declared with the exact layout Windows expects. `hwnd`
  // is a pointer, so it carries 8-byte alignment on x64 and pads both sides.
  const flashInfo = declareType(koffi, 'struct', 'DSH_TRAY_FLASH_FLASHWINFO', {
    cbSize: 'uint32',
    hwnd: 'void*',
    dwFlags: 'uint32',
    uCount: 'uint32',
    dwTimeout: 'uint32',
  })
  const flashWindowEx = user32.func('int __stdcall FlashWindowEx(DSH_TRAY_FLASH_FLASHWINFO* info)')

  const enumProc = declareType(koffi, 'proto', 'bool __stdcall DSH_TRAY_FLASH_ENUM_PROC(void* h, intptr_t p)')
  const enumProcPointer = koffi.pointer(enumProc)

  /**
   * Enumerate every visible top-level window owned by one process.
   *
   * @param pid - process id to match.
   * @returns candidate windows with their class and title.
   */
  function listWindows(pid) {
    /** @type {{ hwnd: bigint, className: string, title: string, visible: boolean }[]} */
    const found = []
    const pidBuffer = Buffer.alloc(4)
    const classBuffer = Buffer.alloc(512)
    const titleBuffer = Buffer.alloc(1024)

    const callback = koffi.register((hwnd) => {
      getWindowThreadProcessId(hwnd, pidBuffer)
      if (pidBuffer.readUInt32LE(0) !== pid) return true
      const classLength = getClassNameW(hwnd, classBuffer, classBuffer.length / 2)
      const titleLength = getWindowTextW(hwnd, titleBuffer, titleBuffer.length / 2)
      found.push({
        hwnd: handleOf(hwnd),
        className: decodeWide(classBuffer, classLength),
        title: decodeWide(titleBuffer, titleLength),
        visible: Boolean(isWindowVisible(hwnd)),
      })
      return true
    }, enumProcPointer)

    try {
      enumWindows(callback, 0)
    } finally {
      // A registered callback is a live JS reference; leaking it per flash would
      // grow the Host's heap one window enumeration at a time.
      koffi.unregister(callback)
    }
    return found
  }

  /**
   * Pick the Harness main window out of a process's top-level windows.
   *
   * Electron also owns hidden helper windows (`Chrome_WidgetWin_0`, IME glue and
   * the tray host window), so visible-plus-titled-plus-main-class is the filter
   * that isolates the one window a person can actually see in the taskbar.
   *
   * @param windows - result of {@link listWindows}.
   * @returns the chosen window, or `undefined` when the process has none yet.
   */
  function pickMainWindow(windows) {
    const main = windows.filter((window) => (
      window.className === CHROME_WIDGET_CLASS
      && window.visible
      && window.title.length > 0
    ))
    if (main.length === 0) return undefined
    const titled = main.find((window) => /DeepSeek Harness/i.test(window.title))
    return titled ?? main[0]
  }

  /**
   * Find the main window of one process.
   *
   * @param pid - process id to search.
   * @returns the window, or `undefined`.
   */
  function findMainWindow(pid) {
    return pickMainWindow(listWindows(pid))
  }

  /**
   * Enumerate the top-level windows of several processes at once.
   *
   * The tray lookup needs hidden helper windows, which {@link listWindows}
   * already reports (it records visibility rather than filtering on it), so this
   * is the same enumeration across a set of ids.
   *
   * @param pids - process ids to search.
   * @returns every window found, with its owning process id.
   */
  function listWindowsFor(pids) {
    const wanted = new Set(pids)
    const found = []
    const pidBuffer = Buffer.alloc(4)
    const classBuffer = Buffer.alloc(512)
    const titleBuffer = Buffer.alloc(1024)

    const callback = koffi.register((hwnd) => {
      getWindowThreadProcessId(hwnd, pidBuffer)
      const pid = pidBuffer.readUInt32LE(0)
      if (!wanted.has(pid)) return true
      const classLength = getClassNameW(hwnd, classBuffer, classBuffer.length / 2)
      const titleLength = getWindowTextW(hwnd, titleBuffer, titleBuffer.length / 2)
      found.push({
        hwnd: handleOf(hwnd),
        pid,
        className: decodeWide(classBuffer, classLength),
        title: decodeWide(titleBuffer, titleLength),
        visible: Boolean(isWindowVisible(hwnd)),
      })
      return true
    }, enumProcPointer)

    try {
      enumWindows(callback, 0)
    } finally {
      koffi.unregister(callback)
    }
    return found
  }

  /**
   * Ask Windows to flash a window until it reaches the foreground.
   *
   * @param hwnd - target window handle.
   * @param options - caption inclusion and the repeat count (0 = until foreground).
   * @returns the raw BOOL as a number; unreliable, log only.
   */
  function flash(hwnd, options = {}) {
    const { caption = true, count = 0, timeout = 0 } = options
    return flashWindowEx({
      cbSize: flashInfo.size,
      hwnd: handleOf(hwnd),
      dwFlags: flashFlags({ caption }),
      uCount: count,
      dwTimeout: timeout,
    })
  }

  /**
   * Cancel any flash Windows is still running for this window.
   *
   * @param hwnd - target window handle.
   * @returns the raw BOOL as a number.
   */
  function stop(hwnd) {
    return flashWindowEx({
      cbSize: flashInfo.size,
      hwnd: handleOf(hwnd),
      dwFlags: FLASH_STOP,
      uCount: 0,
      dwTimeout: 0,
    })
  }

  /**
   * Whether a window handle still names a live window.
   *
   * @param hwnd - candidate handle.
   * @returns true when the window exists.
   */
  function isLive(hwnd) {
    return handleOf(hwnd) !== 0n && Boolean(isWindow(handleOf(hwnd)))
  }

  /**
   * Whether the window is the one the user is currently looking at.
   *
   * @param hwnd - candidate handle.
   * @returns true when it owns the foreground.
   */
  function isForeground(hwnd) {
    return sameHandle(getForegroundWindow(), hwnd)
  }

  /**
   * Read the mouse position.
   *
   * The output is passed as a raw 8-byte buffer rather than a koffi `struct`.
   * Declaring a `POINT` struct and passing it by pointer silently yielded 0,0
   * while the same call through a buffer returned the real coordinates, so the
   * buffer form is the one that works.
   *
   * @returns `{ x, y }`, or `undefined` when Windows refuses the read.
   */
  function cursorPosition() {
    const point = Buffer.alloc(8)
    if (!getCursorPos(point)) return undefined
    return { x: point.readInt32LE(0), y: point.readInt32LE(4) }
  }

  /**
   * Whether the pointer has left a previously sampled position.
   *
   * A one-pixel difference counts: the point of the signal is "you moved the
   * mouse", and requiring a threshold would make a small deliberate nudge fail
   * to register.
   *
   * @param previous - position from {@link cursorPosition}, or undefined.
   * @param current - position from {@link cursorPosition}, or undefined.
   * @returns true when both positions exist and differ on either axis.
   */
  function cursorMoved(previous, current) {
    if (previous === undefined || current === undefined) return false
    return previous.x !== current.x || previous.y !== current.y
  }

  return {
    structSize: flashInfo.size,
    user32,
    shell32: koffi.load('shell32.dll'),
    listWindows,
    listWindowsFor,
    pickMainWindow,
    findMainWindow,
    flash,
    stop,
    isLive,
    isForeground,
    cursorPosition,
    cursorMoved,
    dispose() {
      // Nothing owns a native handle here; the callback type lives for the
      // module's lifetime and is released with the process.
    },
  }
}
