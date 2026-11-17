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
    'render.title': '生成含 git 标注的副本并打开',
    'render.tabTitle': '（git 标注）',
    'render.fail': '无法生成：非 git 仓库或读取失败',
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
    'render.title': 'Generate a git-marked copy of this file and open it',
    'render.tabTitle': ' (git marked)',
    'render.fail': 'Failed to generate: not a git repository or unreadable',
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
    if (!isText || !complete || addressKey === undefined) {
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
 * renderer. The marked document is produced purely from the raw source text —
 * no DOM involvement — and the marks are `data-gm` elements the stylesheet
 * (or the user's custom CSS) colors.
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
        if (typeof fail === 'function') fail(copy('render.fail'))
        return
      }
      var betterSidebar
      try {
        betterSidebar = ctx.get('betterSidebar')
      } catch (error) {
        betterSidebar = undefined
      }
      if (betterSidebar === undefined || betterSidebar === null
        || typeof betterSidebar.openTab !== 'function') {
        if (typeof fail === 'function') fail(copy('render.fail'))
        return
      }
      betterSidebar.openTab({ type: 'editor', path: payload.path, title: path.split('/').pop() + copy('render.tabTitle') })
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
