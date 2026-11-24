// dsh-git-mark client binding — the document body, the plugin body, and the
// better-sidebar "generate git-marked copy" button. Plain function bodies (no
// imports/exports, no JSX); tools/build-client.mjs embeds this verbatim inside
// the browser loader factory, next to the core functions from
// src/client/inject-core.js. Free variables at runtime: React, MarkdownText,
// parseFileAddress, markdownImageUrl, injectMarkdown, document, fetch,
// URLSearchParams, AbortController.

/** Minimal copy this body needs from the surrounding preview namespace. */
var GIT_MARK_LOCALE = {
  zh: {
    'viewer.label': 'Markdown（git 标注）',
    'code.copy': '复制',
    'code.copied': '已复制',
    'codeBlock.title': '代码块',
    'codeBlock.wrap': '自动换行',
    'codeBlock.unwrap': '取消换行',
    'footnotes': '脚注',
    'render.label': 'Git 标注副本',
    'render.title': '生成或刷新含 git 标注的副本',
    'render.tabTitle': '（git 标注）',
    'render.fail': '无法生成：非 git 仓库或读取失败',
    'render.noSource': '无法更新：找不到该副本对应的源文件',
    'render.refreshFallback': '副本已更新：请用标题栏的刷新按钮重新查看',
  },
  en: {
    'viewer.label': 'Markdown (git marked)',
    'code.copy': 'Copy',
    'code.copied': 'Copied',
    'codeBlock.title': 'Code',
    'codeBlock.wrap': 'Wrap',
    'codeBlock.unwrap': 'Unwrap',
    'footnotes': 'Footnotes',
    'render.label': 'Git-marked copy',
    'render.title': 'Generate or refresh the git-marked copy',
    'render.tabTitle': ' (git marked)',
    'render.fail': 'Failed to generate: not a git repository or unreadable',
    'render.noSource': 'Cannot update: the source file of this copy was not found',
    'render.refreshFallback': 'Copy updated: press the header refresh button to view it',
  },
}

/** A small diff glyph for the better-sidebar header button. */
function RenderMarkIcon(props) {
  var size = props !== undefined && props !== null && props.size ? props.size : 14
  return React.createElement('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, React.createElement('path', {
    d: 'M4 2h8v12l-1-.85L9.6 14l-1.6-1.15L6.4 14 5 13.15V2h1zM5 3v8h6V3z',
  }))
}

// Whether a file path is one of this plugin's marked copies (the mirror tree
// below `.dsh/git-mark/`) — `isMarkedCopyPath` comes from the embedded core
// (src/client/inject-core.js).

/** How often the auto-refresh poller asks about open copies. */
var GIT_MARK_POLL_MS = 2000

/** Largest number of copy tabs one poll tick will check. */
var GIT_MARK_POLL_LIMIT = 8

/**
 * Copies whose file changed while their tab was NOT the one on screen, keyed by
 * copy path. A copy is reloaded only when it is active, so a background refresh
 * can never take the reader's view; the flag survives until that happens.
 */
var gitMarkStaleCopies = {}

/** A copy file's own name (mirror layout keeps the source's basename). */
function copyTabTitle(tabPath, suffix) {
  return String(tabPath).split(/[\\/]/).pop() + suffix
}

/**
 * Read one Host observable (`getSnapshot` on current hosts, `get` on older ones).
 * @param observable - the observable, or the plain value already read.
 * @returns its current value, or undefined.
 */
function gitMarkSnapshot(observable) {
  if (observable === undefined || observable === null) return undefined
  try {
    if (typeof observable.getSnapshot === 'function') return observable.getSnapshot()
    if (typeof observable.get === 'function') return observable.get()
    return observable
  } catch (error) {
    return undefined
  }
}

/** The Host's right-Sidebar controller, or undefined when it publishes none. */
function gitMarkSidebarRight(ctx) {
  try {
    return ctx.get('sidebarRight')
  } catch (error) {
    return undefined
  }
}

/** The Session currently on screen (the only layout this client may rewrite). */
function gitMarkMountedSession(sidebarRight) {
  var value = gitMarkSnapshot(sidebarRight.mounted)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Every open tab row the Host keeps (authoritative, unlike a plugin's records). */
function gitMarkOpenTabRows(sidebarRight) {
  var inventory = sidebarRight.openTabs
  var value = gitMarkSnapshot(inventory === undefined || inventory === null ? undefined : inventory.source)
  return Array.isArray(value) ? value : []
}

/**
 * The committed tab ids of one Session, from the controller's own accessor. This
 * is the membership source that reliably answers "is this tab still open"; the
 * published inventory snapshot can be empty on a Host that never adopted it.
 * @param sidebarRight - the right-Sidebar controller.
 * @param sessionId - the Session whose layout to read.
 * @returns inventory-shaped rows (`{ sessionId, tabId }`), or [] when unavailable.
 */
function gitMarkSessionTabRows(sidebarRight, sessionId) {
  var rows = []
  if (typeof sidebarRight.tabsIn === 'function') {
    try {
      var committed = sidebarRight.tabsIn(sessionId)
      if (Array.isArray(committed)) rows = committed
    } catch (error) {
      rows = []
    }
  }
  if (rows.length === 0) return gitMarkOpenTabRows(sidebarRight)
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (row === null || typeof row !== 'object') continue
    var id = typeof row.id === 'string' ? row.id : row.tabId
    if (typeof id !== 'string' || id === '') continue
    out.push({ sessionId: sessionId, tabId: id })
  }
  return out
}

/** The editor tabs better-sidebar reports (they carry the file paths). */
function gitMarkNativePathTabs(ctx) {
  var betterSidebar
  try {
    betterSidebar = ctx.get('betterSidebar')
  } catch (error) {
    return []
  }
  if (betterSidebar === undefined || betterSidebar === null || typeof betterSidebar.nativePathTabs !== 'function') return []
  try {
    var rows = betterSidebar.nativePathTabs()
    return Array.isArray(rows) ? rows : []
  } catch (error) {
    return []
  }
}

/** The tab the reader is looking at, when the Host can say. */
function gitMarkActiveTabId(sidebarRight) {
  if (typeof sidebarRight.active !== 'function') return undefined
  try {
    var active = sidebarRight.active()
    if (active === null || active === undefined) return undefined
    if (typeof active.id === 'string') return active.id
    if (typeof active.tabId === 'string') return active.tabId
  } catch (error) {
    /* an unreadable active tab only means "reload nothing this tick" */
  }
  return undefined
}

/**
 * Whether one tab id is still open, re-read from the Host inventory. This is the
 * guard that keeps a reload from resurrecting a tab the reader just closed.
 * @param sidebarRight - the right-Sidebar controller.
 * @param tabId - the tab to look for.
 * @returns true while the Host still lists it.
 */
function gitMarkTabStillOpen(sidebarRight, tabId, sessionId) {
  var rows = gitMarkSessionTabRows(sidebarRight, sessionId)
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (row === null || typeof row !== 'object') continue
    if (row.tabId === tabId || row.id === tabId) return true
  }
  return false
}

/**
 * Close one copy tab and reopen it on the next tick, so better-sidebar loads the
 * regenerated file (it exposes no reload for an open tab). Only called for the
 * active tab, so the reopen may take the view back.
 * @param betterSidebar - the sidebar service.
 * @param tab - `{ id, path, seatSessionId }` of the tab to reload.
 * @param titleSuffix - localized tab-title suffix.
 */
function reloadCopyTab(betterSidebar, tab, titleSuffix) {
  if (typeof betterSidebar.closeTab !== 'function' || typeof betterSidebar.openTab !== 'function') return
  betterSidebar.closeTab(tab.id, { sessionId: tab.seatSessionId })
  setTimeout(function () {
    betterSidebar.openTab({
      type: 'editor',
      path: tab.path,
      title: copyTabTitle(tab.path, titleSuffix),
      reveal: true,
    })
  }, 0)
}

/**
 * Check one open copy: mark it stale when its file changed, and reload it right
 * away when it is also the tab on screen.
 * @param ctx - client plugin context.
 * @param tab - `{ id, path, address, sessionId, seatSessionId }` to check.
 * @param copy - plugin locale resolver.
 */
function checkOneCopy(ctx, tab, copy) {
  var query = new URLSearchParams({ sessionId: tab.sessionId, path: tab.path })
  fetch('/api/dsh-git-mark/watch?' + query.toString())
    .then(function (response) { return response.json() })
    .then(function (payload) {
      if (payload !== null && payload !== undefined && payload.changed === true) {
        gitMarkStaleCopies[tab.path] = true
      } else {
        delete gitMarkStaleCopies[tab.path]
      }
      if (gitMarkStaleCopies[tab.path] !== true) return
      var sidebarRight = gitMarkSidebarRight(ctx)
      if (sidebarRight === undefined || sidebarRight === null) return
      // Only the visible copy is reloaded: a reopen takes focus by design.
      if (gitMarkActiveTabId(sidebarRight) !== tab.id) return
      // Re-read the inventory right before acting: a tab the reader closed in
      // the meantime must stay closed instead of being reopened by the reload.
      if (!gitMarkTabStillOpen(sidebarRight, tab.id, tab.seatSessionId)) return
      var betterSidebar
      try {
        betterSidebar = ctx.get('betterSidebar')
      } catch (error) {
        betterSidebar = undefined
      }
      if (betterSidebar === undefined || betterSidebar === null) return
      delete gitMarkStaleCopies[tab.path]
      reloadCopyTab(betterSidebar, tab, copy('render.tabTitle'))
    })
    .catch(function () {
      // A failed poll is silent: the manual button and the next tick retry.
    })
}

/**
 * Run one poll pass: read the Host's tab inventory, check every open copy, and
 * drop stale flags of copies that closed.
 * @param ctx - client plugin context.
 * @param copy - plugin locale resolver.
 * @returns what the pass saw (also the shape the diagnostics entry returns).
 */
function runPollTick(ctx, copy) {
  var sidebarRight = gitMarkSidebarRight(ctx)
  if (sidebarRight === undefined || sidebarRight === null) return { skipped: 'no-sidebar-right' }
  var sessionId = gitMarkMountedSession(sidebarRight)
  if (sessionId === undefined) return { skipped: 'no-mounted-session' }
  var nativeTabs = gitMarkNativePathTabs(ctx)
  var openTabs = gitMarkSessionTabRows(sidebarRight, sessionId)
  var candidates = gitMarkCopyCandidates(nativeTabs, openTabs, sessionId, GIT_MARK_POLL_LIMIT)
  var live = {}
  for (var i = 0; i < candidates.length; i++) {
    live[candidates[i].path] = true
    checkOneCopy(ctx, candidates[i], copy)
  }
  // Stale flags of copies that are no longer open must not accumulate.
  for (var path in gitMarkStaleCopies) {
    if (live[path] !== true) delete gitMarkStaleCopies[path]
  }
  return {
    mounted: sessionId,
    active: gitMarkActiveTabId(sidebarRight),
    nativeTabs: nativeTabs,
    openTabs: openTabs,
    inventoryRows: gitMarkOpenTabRows(sidebarRight),
    tabsInAvailable: typeof sidebarRight.tabsIn === 'function',
    candidates: candidates,
    stale: Object.keys(gitMarkStaleCopies),
    visibility: typeof document === 'undefined' ? 'n/a' : document.visibilityState,
  }
}

/**
 * The auto-refresh poller: once per interval, ask the Host whether the source of
 * each open copy changed, and reload the copy the reader is looking at.
 * @param ctx - client plugin context.
 * @param copy - plugin locale resolver.
 * @returns the disposer that stops the timer.
 */
function startAutoRefresh(ctx, copy) {
  if (typeof setInterval !== 'function') return undefined
  var timer = setInterval(function () {
    // A hidden page runs no poll at all: the reader cannot see a refresh.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    runPollTick(ctx, copy)
  }, GIT_MARK_POLL_MS)
  return function () { clearInterval(timer) }
}

/**
 * A read-only diagnostics entry (`window.__dshGitMark`): what the poller sees,
 * and a manual tick that runs the same pass synchronously. Nothing here writes
 * files or tabs — `tick()` only re-runs the checks the interval would run.
 * @param ctx - client plugin context.
 * @param copy - plugin locale resolver.
 * @returns the disposer that removes the entry.
 */
function installDiagnostics(ctx, copy) {
  if (typeof window === 'undefined') return undefined
  window.__dshGitMark = {
    tick: function () { return runPollTick(ctx, copy) },
    stale: function () { return Object.keys(gitMarkStaleCopies) },
    watch: function (sessionId, path) {
      var query = new URLSearchParams({ sessionId: sessionId, path: path })
      return fetch('/api/dsh-git-mark/watch?' + query.toString()).then(function (response) { return response.json() })
    },
  }
  return function () {
    try {
      delete window.__dshGitMark
    } catch (error) {
      /* a frozen window object is not worth failing the teardown for */
    }
  }
}

/**
 * The Keyed document body: the builtin Markdown rendering, with change marks
 * relative to HEAD inserted into an in-memory copy of the file text.
 * @param props - the document owner's content, address, reader, and copy.
 * @returns the rendered document, or nothing for a non-text delivery.
 */
function GitMarkBody(props) {
  var content = props.content
  var resourceAddress = props.resourceAddress
  var useResource = props.useResource
  var t = typeof props.t === 'function' ? props.t : function (key) { return key }
  var isText = content !== undefined && content !== null && content.kind === 'text'
  var text = isText ? content.text : ''
  var complete = isText && content.eof === true

  // The address the Host reported for the file on disk; only used for images.
  var absolutePath
  try {
    var resource = useResource(resourceAddress)
    absolutePath = resource !== undefined && resource !== null && resource.value !== undefined
      ? resource.value.absolutePath
      : undefined
  } catch (error) {
    absolutePath = undefined
  }

  var file = parseFileAddress(resourceAddress)
  var sessionId = file === undefined ? undefined : file.sessionId
  var filePath = file === undefined ? undefined : file.path
  var addressKey = file === undefined ? undefined : sessionId + '|' + filePath

  var state = React.useState(null)
  var marks = state[0]
  var setMarks = state[1]

  React.useEffect(function () {
    if (!isText || !complete || addressKey === undefined || isMarkedCopyPath(filePath)) {
      setMarks(null)
      return undefined
    }
    var controller = new AbortController()
    var timer = setTimeout(function () {
      var query = new URLSearchParams({ sessionId: sessionId, path: filePath })
      fetch('/api/dsh-git-mark?' + query.toString(), { signal: controller.signal })
        .then(function (response) { return response.json() })
        .then(function (payload) { setMarks(payload !== null && payload.kind === 'text' ? payload : null) })
        .catch(function () { if (!controller.signal.aborted) setMarks(null) })
    }, 150)
    return function () {
      clearTimeout(timer)
      controller.abort()
    }
  }, [isText, complete, addressKey, text])

  var marked = React.useMemo(function () {
    if (!isText) return ''
    if (marks === null) return text
    try {
      return injectMarkdown(text, marks)
    } catch (error) {
      return text
    }
  }, [isText, text, marks])

  var pathImages = React.useMemo(function () {
    return {
      resolve: function (destination) {
        return markdownImageUrl(document.baseURI, absolutePath, destination)
      },
    }
  }, [absolutePath])

  var labels = React.useMemo(function () {
    return {
      code: {
        copyLabel: t('code.copy'),
        copiedLabel: t('code.copied'),
        toolbarLabels: {
          codeLabel: t('codeBlock.title'),
          wrapLabel: t('codeBlock.wrap'),
          unwrapLabel: t('codeBlock.unwrap'),
        },
      },
      footnotes: t('footnotes'),
    }
  }, [t])

  if (!isText) return null
  return React.createElement(
    'div',
    { className: 'git-mark-document', 'data-document-markdown': '' },
    React.createElement(MarkdownText, {
      text: marked,
      streaming: !complete,
      labels: labels,
      pathImages: pathImages,
    }),
  )
}

/**
 * The better-sidebar render button: ask the Host to write a git-marked copy
 * of the open file under `<workspace>/.dsh/git-mark/`, then open that copy so
 * better-sidebar renders the mixed Markdown/HTML document with its full
 * renderer. When the open tab IS a marked copy, the same call refreshes the
 * copy in place: the Host regenerates it from the copy's source, and the tab
 * is closed and reopened so the fresh content shows (better-sidebar has no
 * public reload). The marked document is produced purely from the raw source
 * text — no DOM involvement — and the marks are `data-gm` elements the
 * stylesheet (or the user's custom CSS) colors.
 * @param ctx - client plugin context.
 * @param context - the TabActionContext the editor header supplied.
 * @param copy - plugin locale resolver.
 */
function runRenderMarked(ctx, context, copy) {
  var path = context.path
  var sessionId = context.sessionId
  var fail = context.fail
  if (typeof path !== 'string' || path === '' || typeof sessionId !== 'string' || sessionId === '') return
  fetch('/api/dsh-git-mark/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, path: path }),
  })
    .then(function (response) { return response.json() })
    .then(function (payload) {
      if (payload === null || payload.kind !== 'created') {
        var failKey = payload !== null && payload.kind === 'no-source' ? 'render.noSource' : 'render.fail'
        if (typeof fail === 'function') fail(copy(failKey))
        return
      }
      var betterSidebar
      try {
        betterSidebar = ctx.get('betterSidebar')
      } catch (error) {
        betterSidebar = undefined
      }
      if (betterSidebar === undefined || betterSidebar === null) {
        if (typeof fail === 'function') fail(copy('render.fail'))
        return
      }
      // Copy tabs are titled from the SOURCE file so they differ from the
      // source's own tab when both are open.
      var title = String(payload.sourcePath || path).split(/[\\/]/).pop() + copy('render.tabTitle')
      if (payload.refreshed === true) {
        // Refresh in place: close the current copy tab, then reopen the same
        // path on the next tick so better-sidebar loads the regenerated file.
        if (typeof betterSidebar.closeTab !== 'function' || typeof betterSidebar.openTab !== 'function') {
          if (typeof fail === 'function') fail(copy('render.refreshFallback'))
          return
        }
        reloadCopyTab(betterSidebar, { id: context.tabId, path: path, seatSessionId: sessionId }, copy('render.tabTitle'))
        return
      }
      betterSidebar.openTab({ type: 'editor', path: payload.path, title: title })
    })
    .catch(function () {
      if (typeof fail === 'function') fail(copy('render.fail'))
    })
}

/**
 * Plugin body: dictionaries, the Markdown implementation metadata, its Keyed
 * body registration, the better-sidebar render button, and the stylesheets
 * (diff colors for the native body and for `data-gm` marks in marked copies).
 * @param ctx - the client plugin context carrying slots, locale, and previews.
 */
function applyGitMark(ctx) {
  var NS = 'gitMark'
  var BODY_ID = 'dsh-git-mark/markdown'

  ctx.effect(function () {
    try {
      return ctx.locale.register(NS, GIT_MARK_LOCALE)
    } catch (error) {
      return undefined
    }
  }, 'dsh-git-mark: dictionaries')

  var copy = function (key) {
    try {
      return ctx.locale.bind(NS)(key)
    } catch (error) {
      return key
    }
  }

  // `extension` outranks the builtin Markdown implementation for .md/.markdown.
  ctx.effect(function () {
    return ctx.documentPreviews.register({
      id: BODY_ID,
      extensions: ['md', 'markdown'],
      priority: 'extension',
      title: function () { return copy('viewer.label') },
      loading: 'text-pages',
      wrap: false,
    })
  }, 'dsh-git-mark: markdown metadata')

  ctx.effect(function () {
    return ctx.slots.inject('sidebar.right.tab.document', function () {
      return ctx.slots.register(
        { name: 'sidebar.right.tab.document', key: BODY_ID, locale: NS },
        GitMarkBody,
      )
    })
  }, 'dsh-git-mark: markdown body')

  ctx.effect(function () {
    var element = document.createElement('style')
    element.setAttribute('data-plugin', 'dsh-git-mark')
    // Host semantic tokens (the same ones better-sidebar's own diff panel and
    // DSH's theme registry define): error = deleted, success = added.
    element.textContent = [
      '[data-document-markdown] del{color:var(--dsw-alias-state-error-primary);'
        + 'text-decoration-color:var(--dsw-alias-state-error-primary)}',
      '[data-document-markdown] em{font-style:normal;color:var(--dsw-alias-state-success-primary)}',
      '[data-gm="del"]{color:var(--dsw-alias-state-error-primary);'
        + 'text-decoration-color:var(--dsw-alias-state-error-primary)}',
      '[data-gm="add"]{font-style:normal;color:var(--dsw-alias-state-success-primary)}',
    ].join('')
    document.head.appendChild(element)
    return function () { element.remove() }
  }, 'dsh-git-mark: change-mark styles')

  // Auto-refresh: while the page is visible, ask the Host whether the source of
  // every OPEN marked copy changed, and reload the copy the reader is watching.
  ctx.effect(function () {
    return startAutoRefresh(ctx, copy)
  }, 'dsh-git-mark: auto refresh')

  // Read-only diagnostics for a misbehaving poll (see installDiagnostics).
  ctx.effect(function () {
    return installDiagnostics(ctx, copy)
  }, 'dsh-git-mark: diagnostics')

  // Bridge to better-sidebar: a header button on its editor that writes a
  // git-marked copy of the open file and opens it. Default .md behaviour is
  // untouched — better-sidebar keeps rendering everything itself.
  ctx.effect(function () {
    var betterSidebar
    try {
      betterSidebar = ctx.get('betterSidebar')
    } catch (error) {
      betterSidebar = undefined
    }
    if (betterSidebar === undefined || betterSidebar === null
      || typeof betterSidebar.registerTabAction !== 'function') {
      return undefined
    }
    return betterSidebar.registerTabAction({
      id: 'dsh-git-mark/render',
      label: function () { return copy('render.label') },
      title: function () { return copy('render.title') },
      icon: function (size) { return React.createElement(RenderMarkIcon, { size: size || 14 }) },
      order: 90,
      when: function (context) {
        if (context === undefined || context.isDir) return false
        return /\.(md|markdown)$/i.test(context.path)
      },
      run: function (context) { runRenderMarked(ctx, context, copy) },
    })
  }, 'dsh-git-mark: better-sidebar render button')
}
