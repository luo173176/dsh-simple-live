/**
 * dsh-simple-live — Client half.
 *
 * One sidebar entry + one main panel:
 *   top bar: brand · centered search · refresh · 我的
 *   row 2   : platform chips (bilibili/douyu/huya/douyin) + 关注
 *   row 3/4 : category chips (two levels)
 *   body    : room grid (scrolls, load-more below the grid)
 *   player  : HLS video + danmaku overlay + danmaku chat list
 *   我的    : link parse / watch history / account cookie / settings
 *
 * @module dsh-simple-live/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-simple-live',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-simple-live'
    const PANEL_ID = 'simple-live'
    const API = '/simple-live/api'
    const STREAM = '/simple-live/stream'
    const HLS_SRC = '/simple-live/vendor/hls.min.js'

    /* ------------------------------------------------------------- locale --- */

    const DICTS = {
      zh: {
        'nav.label': '聚合直播',
        'page.title': '聚合直播',
        'page.tab.follow': '关注',
        'page.searchPlaceholder': '搜索主播或房间',
        'page.refresh': '刷新',
        'page.loading': '加载中…',
        'page.loadMore': '加载更多',
        'page.empty': '这个分区暂时没有直播间',
        'page.emptyFollow': '还没有关注，点卡片右下角的 ♥ 收藏',
        'page.emptySearch': '没有搜到直播间',
        'page.failed': '加载失败',
        'page.retry': '重试',
        'page.live': '直播中',
        'page.close': '关闭',
        'page.follow': '关注',
        'page.unfollow': '取消关注',
        'page.all': '全部',
        'page.noQuality': '这个房间暂时没有可用的清晰度',
        'page.flvUnsupported': '这个清晰度是 FLV 流，浏览器不能直接播放，请换一个 HLS 清晰度',
        'page.noHls': '当前浏览器不支持 HLS 播放',
        'page.openFailed': '打开直播间失败',
        'page.searching': '搜索结果',
        'page.backToArea': '返回分区',
        'me.button': '我的',
        'me.title': '我的',
        'me.tab.link': '解析链接',
        'me.tab.history': '观看记录',
        'me.tab.account': '账号登录',
        'me.tab.settings': '播放设置',
        'me.link.placeholder': '粘贴直播间链接，或 平台:房间号',
        'me.link.open': '打开直播间',
        'me.link.tip': '支持哔哩哔哩 / 斗鱼 / 虎牙 / 抖音 的直播间链接。',
        'me.link.bad': '识别不出房间号，换个链接试试',
        'me.history.empty': '还没有观看记录',
        'me.history.clear': '清空记录',
        'me.history.open': '打开',
        'me.history.remove': '删除',
        'me.account.tip': '粘贴对应平台的登录 cookie（如 B 站的 SESSDATA），可提升搜索成功率与清晰度；只保存在本机。',
        'me.account.saved': '已保存',
        'me.account.none': '未登录',
        'me.account.placeholder': '粘贴 cookie，例如 SESSDATA=xxxx; bili_jct=yyyy',
        'me.account.save': '保存',
        'me.account.remove': '清除',
        'me.settings.danmaku': '显示弹幕',
        'me.settings.opacity': '弹幕透明度',
        'me.settings.size': '弹幕字号',
        'me.settings.speed': '弹幕速度',
        'me.settings.autoplay': '打开房间自动播放',
        'me.settings.reset': '恢复默认',
        'page.danmaku': '弹幕',
        'page.danmakuOn': '弹幕开',
        'page.danmakuOff': '弹幕关',
        'page.danmakuCollapse': '收起弹幕',
        'page.danmakuExpand': '展开弹幕',
        'dan.connecting': '弹幕连接中…',
        'dan.open': '弹幕已连接',
        'dan.closed': '弹幕已断开',
        'dan.unsupported': '该平台弹幕暂不支持',
        'dan.error': '弹幕连接出错',
        'dan.empty': '还没有人说话',
      },
      en: {
        'nav.label': 'Live',
        'page.title': 'Live',
        'page.tab.follow': 'Following',
        'page.searchPlaceholder': 'Search a streamer or room',
        'page.refresh': 'Refresh',
        'page.loading': 'Loading…',
        'page.loadMore': 'Load more',
        'page.empty': 'No live room in this category',
        'page.emptyFollow': 'Nothing followed yet — tap the ♥ on a card',
        'page.emptySearch': 'No live room found',
        'page.failed': 'Failed to load',
        'page.retry': 'Retry',
        'page.live': 'LIVE',
        'page.close': 'Close',
        'page.follow': 'Follow',
        'page.unfollow': 'Unfollow',
        'page.all': 'All',
        'page.noQuality': 'No playable quality right now',
        'page.flvUnsupported': 'This quality is an FLV stream, which the browser cannot play — pick an HLS quality',
        'page.noHls': 'This browser cannot play HLS',
        'page.openFailed': 'Could not open the room',
        'page.searching': 'Results',
        'page.backToArea': 'Back',
        'me.button': 'Me',
        'me.title': 'Me',
        'me.tab.link': 'Open link',
        'me.tab.history': 'History',
        'me.tab.account': 'Account',
        'me.tab.settings': 'Settings',
        'me.link.placeholder': 'Paste a live URL, or platform:roomId',
        'me.link.open': 'Open room',
        'me.link.tip': 'Works with bilibili / douyu / huya / douyin live links.',
        'me.link.bad': 'Could not find a room id in that link',
        'me.history.empty': 'No watch history yet',
        'me.history.clear': 'Clear',
        'me.history.open': 'Open',
        'me.history.remove': 'Remove',
        'me.account.tip': 'Paste the platform login cookie (e.g. bilibili SESSDATA) to improve search and quality. Stored locally only.',
        'me.account.saved': 'Saved',
        'me.account.none': 'Not signed in',
        'me.account.placeholder': 'Paste cookie, e.g. SESSDATA=xxxx; bili_jct=yyyy',
        'me.account.save': 'Save',
        'me.account.remove': 'Clear',
        'me.settings.danmaku': 'Show danmaku',
        'me.settings.opacity': 'Danmaku opacity',
        'me.settings.size': 'Danmaku size',
        'me.settings.speed': 'Danmaku speed',
        'me.settings.autoplay': 'Autoplay on open',
        'me.settings.reset': 'Reset',
        'page.danmaku': 'Danmaku',
        'page.danmakuOn': 'Danmaku on',
        'page.danmakuOff': 'Danmaku off',
        'page.danmakuCollapse': 'Hide chat',
        'page.danmakuExpand': 'Show chat',
        'dan.connecting': 'Connecting danmaku…',
        'dan.open': 'Danmaku connected',
        'dan.closed': 'Danmaku disconnected',
        'dan.unsupported': 'Danmaku not supported on this platform',
        'dan.error': 'Danmaku error',
        'dan.empty': 'No messages yet',
      },
    }

    let translate = null
    function t(key) {
      return translate ? translate(key) : key
    }

    /* --------------------------------------------------------------- http --- */

    async function apiGet(path, params) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      const res = await fetch(API + path + qs, { headers: { accept: 'application/json' } })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.error) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }

    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.error) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }

    function message(err) {
      return String((err && err.message) || err || '')
    }

    function fmtOnline(n) {
      const v = Number(n) || 0
      if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
      if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万'
      return String(v)
    }

    function fmtTime(ts) {
      const d = new Date(Number(ts) || Date.now())
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function coverSrc(platform, url) {
      if (!url) return ''
      const absolute = url.startsWith('//') ? 'https:' + url : url
      if (!/^https?:\/\//i.test(absolute)) return ''
      return STREAM + '?platform=' + encodeURIComponent(platform) + '&u=' + encodeURIComponent(absolute)
    }

    /* ------------------------------------------------------------- hls.js --- */

    let hlsPromise = null
    function loadHls() {
      if (hlsPromise) return hlsPromise
      hlsPromise = new Promise((resolve) => {
        if (window.Hls) return resolve(window.Hls)
        const script = document.createElement('script')
        script.src = HLS_SRC
        script.async = true
        script.onload = () => resolve(window.Hls || null)
        script.onerror = () => resolve(null)
        document.head.appendChild(script)
      })
      return hlsPromise
    }

    /* ------------------------------------------------------------- icons ---- */

    const PATHS = {
      broadcast: [
        'M8.1 6.8a4.9 4.9 0 0 0 0 8.4',
        'M15.9 6.8a4.9 4.9 0 0 1 0 8.4',
        'M5.4 3.9a9 9 0 0 0 0 14.2',
        'M18.6 3.9a9 9 0 0 1 0 14.2',
      ],
      search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.6-3.6'],
      refresh: ['M20 11a8 8 0 1 0-2.3 6.4', 'M20 4v7h-7'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      heart: ['M12 20s-7-4.4-7-9.2A4 4 0 0 1 12 8a4 4 0 0 1 7 2.8C19 15.6 12 20 12 20z'],
      play: ['M8 5.5v13l11-6.5z'],
      user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
      link: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3'],
      clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
      gear: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M19.4 13.5l1.5 1.2-2 3.4-1.8-.8a7.6 7.6 0 0 1-2 1.2l-.3 2h-4l-.3-2a7.6 7.6 0 0 1-2-1.2l-1.8.8-2-3.4 1.5-1.2a7.6 7.6 0 0 1 0-2.4L2.7 9.3l2-3.4 1.8.8a7.6 7.6 0 0 1 2-1.2l.3-2h4l.3 2a7.6 7.6 0 0 1 2 1.2l1.8-.8 2 3.4-1.5 1.2a7.6 7.6 0 0 1 0 2.4z'],
      danmaku: ['M4 5.5h16v11H9l-5 4z', 'M8 9.5h8', 'M8 12.5h5'],
      chevron: ['M15 6l-6 6 6 6'],
    }

    function icon(name, size, noDot) {
      const paths = PATHS[name] || []
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        noDot ? null : h('circle', { key: 'c', cx: 12, cy: 11, r: 2.3, fill: 'currentColor', stroke: 'none' }),
        paths.map((d, i) => h('path', { key: i, d })),
      )
    }

    function heart(size, filled) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: PATHS.heart[0] }),
      )
    }

    /* --------------------------------------------------------- side entry --- */

    function SideIcon(props) {
      return h(
        'span',
        { className: 'sl-side' + (props && props.active ? ' is-on' : '') },
        icon('broadcast', 18),
      )
    }

    /* ------------------------------------------------------------ room card - */

    function RoomCard({ room, platform, followed, busy, onOpen, onToggle }) {
      const [broken, setBroken] = useState(false)
      const live = room.live !== false
      const src = coverSrc(platform, room.cover)
      return h(
        'div',
        {
          className: 'sl-card' + (busy ? ' is-busy' : ''),
          role: 'button',
          tabIndex: 0,
          onClick: onOpen,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen()
            }
          },
        },
        h(
          'div',
          { className: 'sl-cover' },
          broken || !src
            ? h('div', { className: 'sl-cover-ph' }, icon('play', 20, true))
            : h('img', {
                src,
                alt: '',
                loading: 'lazy',
                decoding: 'async',
                onError: () => setBroken(true),
              }),
          live ? h('span', { className: 'sl-badge' }, h('i', { className: 'sl-dot' }), t('page.live')) : null,
          room.online ? h('span', { className: 'sl-online' }, fmtOnline(room.online)) : null,
        ),
        h(
          'div',
          { className: 'sl-info' },
          h('div', { className: 'sl-name', title: room.title || '' }, room.title || room.roomId),
          h(
            'div',
            { className: 'sl-sub' },
            h('span', { className: 'sl-anchor' }, room.anchor || platform),
            room.areaName ? h('span', { className: 'sl-area' }, room.areaName) : null,
          ),
          h(
            'button',
            {
              className: 'sl-fav' + (followed ? ' is-on' : ''),
              onClick: (e) => {
                e.stopPropagation()
                onToggle()
              },
              onKeyDown: (e) => e.stopPropagation(),
              title: t(followed ? 'page.unfollow' : 'page.follow'),
              'aria-label': t(followed ? 'page.unfollow' : 'page.follow'),
              'aria-pressed': !!followed,
            },
            heart(13, followed),
          ),
        ),
      )
    }

    /* -------------------------------------------------------------- player -- */

    function Player({ detail, settings, onClose, onPatchSettings }) {
      const videoRef = useRef(null)
      const chatRef = useRef(null)
      const bulletSeq = useRef(0)
      const laneRef = useRef(0)
      const [index, setIndex] = useState(0)
      const [error, setError] = useState('')
      const [chats, setChats] = useState([])
      const [bullets, setBullets] = useState([])
      const [danState, setDanState] = useState({ state: 'connecting' })
      const [danOpen, setDanOpen] = useState(true)
      const qualities = detail.qualities || []
      const quality = qualities[index]
      const danmakuOn = settings.danmaku !== false

      useEffect(() => {
        setIndex(0)
        setError('')
      }, [detail])

      /* -------- video source -------- */
      const src = quality && quality.src
      useEffect(() => {
        const video = videoRef.current
        if (!video || !src) return
        setError('')
        let cancelled = false
        let hls = null

        if (quality.format !== 'hls') {
          setError(t('page.flvUnsupported'))
          return
        }

        loadHls().then((Hls) => {
          if (cancelled) return
          if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
            hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 })
            hls.loadSource(src)
            hls.attachMedia(video)
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (!data || !data.fatal) return
              setError('HLS ' + (data.details || data.type || 'error'))
            })
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src
          } else {
            setError(t('page.noHls'))
            return
          }
          if (settings.autoplay !== false) {
            const started = video.play()
            if (started && typeof started.catch === 'function') started.catch(() => {})
          }
        })

        return () => {
          cancelled = true
          if (hls) {
            try {
              hls.destroy()
            } catch {
              /* player already gone */
            }
          }
          try {
            video.removeAttribute('src')
            video.load()
          } catch {
            /* element unmounted */
          }
        }
        // 只在换流/换清晰度/自动播放开关时重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [src, quality && quality.format, settings.autoplay])

      /* -------- danmaku SSE -------- */
      useEffect(() => {
        setChats([])
        setBullets([])
        setDanState({ state: 'connecting' })
        const platform = detail.platform
        const roomId = detail.roomId
        let es = null
        let closed = false

        const pushBullet = (msg) => {
          if (settings.danmaku === false) return
          const dur = Math.min(20, Math.max(4, Number(settings.danmakuSpeed) || 10))
          const id = ++bulletSeq.current
          const lane = laneRef.current++ % 7
          setBullets((prev) => prev.concat({ id, text: msg.text, color: msg.color, lane, dur }).slice(-60))
          window.setTimeout(() => {
            setBullets((prev) => prev.filter((b) => b.id !== id))
          }, dur * 1000 + 400)
        }

        try {
          es = new EventSource(
            `${API}/danmaku?platform=${encodeURIComponent(platform)}&roomId=${encodeURIComponent(roomId)}`,
          )
        } catch (err) {
          setDanState({ state: 'error', message: message(err) })
          return
        }

        es.onmessage = (ev) => {
          let data
          try {
            data = JSON.parse(ev.data)
          } catch {
            return
          }
          if (!data || !data.type) return
          if (data.type === 'status') {
            setDanState(data)
            if (data.state === 'unsupported' || data.state === 'closed') {
              closed = true
              try {
                es.close()
              } catch {
                /* ignore */
              }
            }
            return
          }
          if (data.type === 'chat' || data.type === 'gift') {
            const msg = {
              id: ++bulletSeq.current,
              user: String(data.user || ''),
              text: String(data.text || ''),
              color: data.color || '',
              gift: data.type === 'gift',
              ts: Number(data.ts) || Date.now(),
            }
            if (!msg.text) return
            setChats((prev) => {
              const next = prev.concat(msg)
              return next.length > 200 ? next.slice(next.length - 200) : next
            })
            pushBullet(msg)
          }
        }
        es.onerror = () => {
          if (closed) return
          setDanState((prev) => (prev.state === 'open' ? { state: 'error', message: t('dan.error') } : prev))
        }

        return () => {
          closed = true
          try {
            es.close()
          } catch {
            /* ignore */
          }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [detail.platform, detail.roomId])

      /* -------- auto scroll chat -------- */
      useEffect(() => {
        const el = chatRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [chats])

      const danStatusText = () => {
        const s = danState.state
        if (s === 'open') return t('dan.open')
        if (s === 'unsupported') return t('dan.unsupported') + (danState.message ? '：' + danState.message : '')
        if (s === 'error') return t('dan.error') + (danState.message ? '：' + danState.message : '')
        if (s === 'closed') return t('dan.closed')
        return t('dan.connecting')
      }

      return h(
        'div',
        { className: 'sl-player' },
        h(
          'div',
          { className: 'sl-phead' },
          h('span', { className: 'sl-ptitle', title: detail.title || '' }, detail.title || detail.roomId),
          h('span', { className: 'sl-psub' }, detail.anchor || ''),
          h(
            'div',
            { className: 'sl-pquals' },
            qualities.map((q, i) =>
              h(
                'button',
                {
                  key: i,
                  className: 'sl-q' + (i === index ? ' is-on' : ''),
                  onClick: () => setIndex(i),
                },
                q.name,
              ),
            ),
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              onClick: () => setDanOpen((v) => !v),
              title: t(danOpen ? 'page.danmakuCollapse' : 'page.danmakuExpand'),
              'aria-label': t(danOpen ? 'page.danmakuCollapse' : 'page.danmakuExpand'),
              'aria-pressed': !danOpen,
            },
            h('span', { style: { display: 'inline-flex', transform: danOpen ? 'none' : 'rotate(180deg)' } }, icon('chevron', 15, true)),
          ),
          h(
            'button',
            {
              className: 'sl-btn' + (danmakuOn ? ' is-on' : ''),
              onClick: () => onPatchSettings({ danmaku: !danmakuOn }),
              title: t(danmakuOn ? 'page.danmakuOn' : 'page.danmakuOff'),
              'aria-label': t('page.danmaku'),
              'aria-pressed': !!danmakuOn,
            },
            icon('danmaku', 15, true),
          ),
          h(
            'button',
            { className: 'sl-btn', onClick: onClose, title: t('page.close'), 'aria-label': t('page.close') },
            icon('close', 15, true),
          ),
        ),
        h(
          'div',
          { className: 'sl-pbody' },
          h(
            'div',
            { className: 'sl-pstage' },
            h('video', { ref: videoRef, playsInline: true, controls: true, autoPlay: settings.autoplay !== false }),
            danmakuOn
              ? h(
                  'div',
                  { className: 'sl-bullets', style: { opacity: String(settings.danmakuOpacity ?? 0.9) } },
                  bullets.map((b) =>
                    h(
                      'span',
                      {
                        key: b.id,
                        className: 'sl-bullet',
                        style: {
                          top: 6 + b.lane * 30 + 'px',
                          color: b.color || '#fff',
                          fontSize: (Number(settings.danmakuSize) || 16) + 'px',
                          animationDuration: b.dur + 's',
                        },
                      },
                      b.text,
                    ),
                  ),
                )
              : null,
            !qualities.length ? h('div', { className: 'sl-hint' }, t('page.noQuality')) : null,
            error ? h('div', { className: 'sl-perr' }, error) : null,
          ),
          danOpen
            ? h(
            'aside',
            { className: 'sl-dan' },
            h(
              'div',
              { className: 'sl-dan-head' },
              h('span', null, t('page.danmaku')),
              h('span', { className: 'sl-dan-state' + (danState.state === 'open' ? ' is-on' : '') }, danStatusText()),
            ),
            h(
              'div',
              { className: 'sl-dan-list', ref: chatRef },
              chats.length
                ? chats.map((m) =>
                    h(
                      'div',
                      { key: m.id, className: 'sl-dan-item' + (m.gift ? ' is-gift' : '') },
                      m.user ? h('span', { className: 'sl-dan-user' }, m.user + '：') : null,
                      h('span', { className: 'sl-dan-text', style: m.color ? { color: m.color } : undefined }, m.text),
                    ),
                  )
                : h('div', { className: 'sl-dan-empty' }, t('dan.empty')),
            ),
          )
            : null,
        ),
      )
    }

    /* ---------------------------------------------------------- me dialog --- */

    function MeDialog({ sites, platform, settings, onClose, onPatchSettings, onOpenRoom }) {
      const [section, setSection] = useState('link')
      const [link, setLink] = useState('')
      const [linkErr, setLinkErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [history, setHistory] = useState([])
      const [accounts, setAccounts] = useState([])
      const [cookies, setCookies] = useState({})

      useEffect(() => {
        if (section !== 'history') return
        let alive = true
        apiGet('/history')
          .then((d) => alive && setHistory(d.items || []))
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [section])

      useEffect(() => {
        if (section !== 'account') return
        let alive = true
        apiGet('/accounts')
          .then((d) => alive && setAccounts(d.items || []))
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [section])

      const doOpenLink = async () => {
        const raw = link.trim()
        if (!raw) return
        setBusy(true)
        setLinkErr('')
        try {
          const parsed = await apiGet('/parse', { url: raw })
          if (!parsed || !parsed.roomId) throw new Error(t('me.link.bad'))
          onOpenRoom(parsed.platform || platform, parsed.roomId)
          onClose()
        } catch (err) {
          setLinkErr(message(err))
        } finally {
          setBusy(false)
        }
      }

      const removeHistory = async (item) => {
        try {
          const d = await apiPost('/history', { op: 'remove', platform: item.platform, roomId: item.roomId })
          setHistory(d.items || [])
        } catch {
          /* ignore */
        }
      }
      const clearHistory = async () => {
        try {
          const d = await apiPost('/history', { op: 'clear' })
          setHistory(d.items || [])
        } catch {
          /* ignore */
        }
      }
      const saveCookie = async (p) => {
        setBusy(true)
        try {
          const d = await apiPost('/accounts', { platform: p, cookie: cookies[p] || '' })
          setAccounts(d.items || [])
          setCookies((prev) => ({ ...prev, [p]: '' }))
        } catch {
          /* ignore */
        } finally {
          setBusy(false)
        }
      }
      const removeCookie = async (p) => {
        try {
          const d = await apiPost('/accounts', { op: 'remove', platform: p })
          setAccounts(d.items || [])
        } catch {
          /* ignore */
        }
      }

      const accountOf = (p) => accounts.find((a) => a.platform === p)

      const sections = ['link', 'history', 'account', 'settings']

      return h(
        'div',
        { className: 'sl-me-mask', onClick: onClose },
        h(
          'div',
          { className: 'sl-me', onClick: (e) => e.stopPropagation() },
          h(
            'div',
            { className: 'sl-me-head' },
            h('span', { className: 'sl-me-title' }, icon('user', 16, true), h('span', null, t('me.title'))),
            h(
              'button',
              { className: 'sl-btn', onClick: onClose, 'aria-label': t('page.close') },
              icon('close', 14, true),
            ),
          ),
          h(
            'div',
            { className: 'sl-me-tabs' },
            sections.map((key) =>
              h(
                'button',
                { key, className: 'sl-me-tab' + (section === key ? ' is-on' : ''), onClick: () => setSection(key) },
                t('me.tab.' + key),
              ),
            ),
          ),
          h(
            'div',
            { className: 'sl-me-body' },
            section === 'link'
              ? h(
                  'div',
                  { className: 'sl-me-sec' },
                  h('div', { className: 'sl-me-tip' }, t('me.link.tip')),
                  h(
                    'div',
                    { className: 'sl-me-row' },
                    h('input', {
                      className: 'sl-input',
                      value: link,
                      placeholder: t('me.link.placeholder'),
                      onChange: (e) => setLink(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') doOpenLink()
                      },
                    }),
                    h(
                      'button',
                      { className: 'sl-btn-primary', onClick: doOpenLink, disabled: busy },
                      t('me.link.open'),
                    ),
                  ),
                  linkErr ? h('div', { className: 'sl-me-err' }, linkErr) : null,
                )
              : null,
            section === 'history'
              ? h(
                  'div',
                  { className: 'sl-me-sec' },
                  history.length
                    ? h(
                        'div',
                        { className: 'sl-me-hist' },
                        history.map((item) =>
                          h(
                            'div',
                            { key: item.platform + ':' + item.roomId, className: 'sl-me-hist-item' },
                            h('img', { className: 'sl-me-hist-cover', src: coverSrc(item.platform, item.cover), alt: '' }),
                            h(
                              'div',
                              { className: 'sl-me-hist-info' },
                              h('div', { className: 'sl-me-hist-title', title: item.title || '' }, item.title || item.roomId),
                              h(
                                'div',
                                { className: 'sl-me-hist-sub' },
                                (item.anchor || item.platform) + ' · ' + fmtTime(item.at),
                              ),
                            ),
                            h(
                              'button',
                              {
                                className: 'sl-link',
                                onClick: () => {
                                  onOpenRoom(item.platform, item.roomId)
                                  onClose()
                                },
                              },
                              t('me.history.open'),
                            ),
                            h('button', { className: 'sl-link', onClick: () => removeHistory(item) }, t('me.history.remove')),
                          ),
                        ),
                      )
                    : h('div', { className: 'sl-me-empty' }, t('me.history.empty')),
                  history.length
                    ? h('button', { className: 'sl-me-clear', onClick: clearHistory }, t('me.history.clear'))
                    : null,
                )
              : null,
            section === 'account'
              ? h(
                  'div',
                  { className: 'sl-me-sec' },
                  h('div', { className: 'sl-me-tip' }, t('me.account.tip')),
                  sites.map((s) => {
                    const acc = accountOf(s.id)
                    return h(
                      'div',
                      { key: s.id, className: 'sl-me-acc' },
                      h(
                        'div',
                        { className: 'sl-me-acc-head' },
                        h('span', { className: 'sl-me-acc-name' }, s.name),
                        h(
                          'span',
                          { className: 'sl-me-acc-badge' + (acc && acc.saved ? ' is-on' : '') },
                          acc && acc.saved ? t('me.account.saved') + '（' + (acc.preview || '') + '）' : t('me.account.none'),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'sl-me-row' },
                        h('input', {
                          className: 'sl-input',
                          type: 'password',
                          value: cookies[s.id] || '',
                          placeholder: t('me.account.placeholder'),
                          onChange: (e) => setCookies((prev) => ({ ...prev, [s.id]: e.target.value })),
                        }),
                        h(
                          'button',
                          { className: 'sl-btn-primary', onClick: () => saveCookie(s.id), disabled: busy },
                          t('me.account.save'),
                        ),
                        acc && acc.saved
                          ? h('button', { className: 'sl-me-clear', onClick: () => removeCookie(s.id) }, t('me.account.remove'))
                          : null,
                      ),
                    )
                  }),
                )
              : null,
            section === 'settings'
              ? h(
                  'div',
                  { className: 'sl-me-sec' },
                  h(
                    'label',
                    { className: 'sl-me-setting' },
                    h('span', null, t('me.settings.danmaku')),
                    h('input', {
                      type: 'checkbox',
                      checked: settings.danmaku !== false,
                      onChange: (e) => onPatchSettings({ danmaku: e.target.checked }),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'sl-me-setting' },
                    h('span', null, t('me.settings.opacity')),
                    h('input', {
                      type: 'range',
                      min: 0.2,
                      max: 1,
                      step: 0.05,
                      value: Number(settings.danmakuOpacity ?? 0.9),
                      onChange: (e) => onPatchSettings({ danmakuOpacity: Number(e.target.value) }),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'sl-me-setting' },
                    h('span', null, t('me.settings.size')),
                    h('input', {
                      type: 'range',
                      min: 12,
                      max: 28,
                      step: 1,
                      value: Number(settings.danmakuSize ?? 16),
                      onChange: (e) => onPatchSettings({ danmakuSize: Number(e.target.value) }),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'sl-me-setting' },
                    h('span', null, t('me.settings.speed')),
                    h('input', {
                      type: 'range',
                      min: 4,
                      max: 20,
                      step: 1,
                      value: Number(settings.danmakuSpeed ?? 10),
                      onChange: (e) => onPatchSettings({ danmakuSpeed: Number(e.target.value) }),
                    }),
                  ),
                  h(
                    'label',
                    { className: 'sl-me-setting' },
                    h('span', null, t('me.settings.autoplay')),
                    h('input', {
                      type: 'checkbox',
                      checked: settings.autoplay !== false,
                      onChange: (e) => onPatchSettings({ autoplay: e.target.checked }),
                    }),
                  ),
                  h(
                    'button',
                    {
                      className: 'sl-me-clear',
                      onClick: () =>
                        onPatchSettings({
                          danmaku: true,
                          danmakuOpacity: 0.9,
                          danmakuSize: 16,
                          danmakuSpeed: 10,
                          autoplay: true,
                        }),
                    },
                    t('me.settings.reset'),
                  ),
                )
              : null,
          ),
        ),
      )
    }

    /* --------------------------------------------------------------- panel -- */

    function firstArea(groups) {
      const parent = groups && groups[0]
      if (!parent) return ''
      const children = parent.children || []
      const child = children.find((c) => String(c.id) !== '0') || children[0]
      return String(parent.id) + ':' + (child ? child.id : 0)
    }

    function Panel() {
      const [mode, setMode] = useState('area') // area | follow | search
      const [sites, setSites] = useState([])
      const [platform, setPlatform] = useState('bilibili')
      const [cats, setCats] = useState([])
      const [area, setArea] = useState('')
      const [rooms, setRooms] = useState([])
      const [hasMore, setHasMore] = useState(false)
      const [page, setPage] = useState(1)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [keyword, setKeyword] = useState('')
      const [term, setTerm] = useState('')
      const [hits, setHits] = useState([])
      const [hitsMore, setHitsMore] = useState(false)
      const [hitsPage, setHitsPage] = useState(1)
      const [follows, setFollows] = useState([])
      const [playing, setPlaying] = useState(null)
      const [openError, setOpenError] = useState('')
      const [busy, setBusy] = useState('')
      const [nonce, setNonce] = useState(0)
      const [meOpen, setMeOpen] = useState(false)
      const [settings, setSettings] = useState({
        danmaku: true,
        danmakuOpacity: 0.9,
        danmakuSize: 16,
        danmakuSpeed: 10,
        autoplay: true,
      })

      const followedKeys = useMemo(
        () => new Set(follows.map((f) => String(f.platform) + ':' + String(f.roomId))),
        [follows],
      )

      const openRoom = useCallback(async (p, roomId) => {
        const key = String(p) + ':' + String(roomId)
        setBusy(key)
        setOpenError('')
        try {
          const detail = await apiGet('/room', { platform: p, roomId })
          setPlaying({ platform: p, detail })
          apiPost('/history', {
            op: 'add',
            platform: p,
            roomId: detail.roomId,
            room: { title: detail.title, anchor: detail.anchor, cover: detail.cover, areaName: detail.areaName },
          }).catch(() => {})
        } catch (err) {
          setOpenError(t('page.openFailed') + '：' + message(err))
        } finally {
          setBusy('')
        }
      }, [])

      /* platforms + follows + settings */
      useEffect(() => {
        let alive = true
        apiGet('/sites')
          .then((data) => {
            if (!alive) return
            const items = data.items || []
            setSites(items)
            if (items.length && !items.some((s) => s.id === platform)) setPlatform(items[0].id)
          })
          .catch((err) => alive && setError(message(err)))
        apiGet('/follows')
          .then((data) => alive && setFollows(data.items || []))
          .catch(() => {})
        apiGet('/settings')
          .then((data) => {
            if (alive && data && data.value) setSettings((prev) => ({ ...prev, ...data.value }))
          })
          .catch(() => {})
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /* 进入关注页时刷新各主播真实直播状态（本地快照里的 live 可能已过期） */
      useEffect(() => {
        if (mode !== 'follow') return
        let alive = true
        apiGet('/follows', { live: 1 })
          .then((data) => {
            if (alive && data) setFollows(data.items || [])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [mode, nonce])

      const patchSettings = useCallback((patch) => {
        setSettings((prev) => ({ ...prev, ...patch }))
        apiPost('/settings', { patch })
          .then((d) => d && d.value && setSettings((prev) => ({ ...prev, ...d.value })))
          .catch(() => {})
      }, [])

      /* categories for the active platform (area mode only) */
      useEffect(() => {
        let alive = true
        setCats([])
        setArea('')
        setRooms([])
        setError('')
        if (mode !== 'area') {
          return () => {
            alive = false
          }
        }
        apiGet('/categories', { platform })
          .then((data) => {
            if (!alive) return
            const items = data.items || []
            setCats(items)
            setArea(firstArea(items))
          })
          .catch((err) => alive && setError(message(err)))
        return () => {
          alive = false
        }
      }, [platform, mode, nonce])

      /* page 1 of the active area */
      useEffect(() => {
        if (mode !== 'area' || !area) return
        let alive = true
        setLoading(true)
        setError('')
        apiGet('/rooms', { platform, area, page: 1 })
          .then((data) => {
            if (!alive) return
            setRooms(data.items || [])
            setHasMore(!!data.hasMore)
            setPage(1)
          })
          .catch((err) => alive && setError(message(err)))
          .finally(() => alive && setLoading(false))
        return () => {
          alive = false
        }
      }, [platform, area, mode, nonce])

      /* search */
      useEffect(() => {
        if (mode !== 'search' || !term) return
        let alive = true
        setLoading(true)
        setError('')
        apiGet('/search', { platform, keyword: term, page: 1 })
          .then((data) => {
            if (!alive) return
            setHits(data.items || [])
            setHitsMore(!!data.hasMore)
            setHitsPage(1)
          })
          .catch((err) => alive && setError(message(err)))
          .finally(() => alive && setLoading(false))
        return () => {
          alive = false
        }
      }, [platform, term, mode, nonce])

      /* model → panel playback channel */
      useEffect(() => {
        let seq = 0
        let stopped = false
        const tick = async () => {
          try {
            const data = await apiGet('/control', { since: seq })
            if (stopped || typeof data.seq !== 'number' || data.seq <= seq) return
            seq = data.seq
            const action = data.action
            if (!action || !action.platform || !action.roomId) return
            setPlatform(action.platform)
            openRoom(action.platform, String(action.roomId))
          } catch {
            /* host restarted — retry next tick */
          }
        }
        const timer = setInterval(tick, 3000)
        tick()
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [openRoom])

      const toggleFollow = useCallback(async (room) => {
        try {
          const data = await apiPost('/follows', {
            op: 'toggle',
            platform: room.platform,
            roomId: room.roomId,
            room,
          })
          setFollows(data.items || [])
        } catch (err) {
          setError(message(err))
        }
      }, [])

      const more = async () => {
        if (loading) return
        setLoading(true)
        try {
          if (mode === 'search') {
            const data = await apiGet('/search', { platform, keyword: term, page: hitsPage + 1 })
            setHits((prev) => prev.concat(data.items || []))
            setHitsMore(!!data.hasMore)
            setHitsPage((n) => n + 1)
          } else {
            const data = await apiGet('/rooms', { platform, area, page: page + 1 })
            setRooms((prev) => prev.concat(data.items || []))
            setHasMore(!!data.hasMore)
            setPage((n) => n + 1)
          }
        } catch (err) {
          setError(message(err))
        } finally {
          setLoading(false)
        }
      }

      const parent = useMemo(() => {
        const id = String(area).split(':')[0]
        return cats.find((c) => String(c.id) === id) || cats[0]
      }, [cats, area])
      const children = (parent && parent.children) || []

      const list = mode === 'search' ? hits : mode === 'follow' ? follows : rooms
      const moreFlag = mode === 'search' ? hitsMore : mode === 'area' ? hasMore : false
      const activeSite = sites.find((s) => s.id === platform)

      const card = (room, index) => {
        const p = room.platform || platform
        return h(RoomCard, {
          key: String(p) + ':' + String(room.roomId) + ':' + index,
          room,
          platform: p,
          followed: followedKeys.has(String(p) + ':' + String(room.roomId)),
          busy: busy === String(p) + ':' + String(room.roomId),
          onOpen: () => openRoom(p, room.roomId),
          onToggle: () => toggleFollow({ ...room, platform: p }),
        })
      }

      const submitSearch = () => {
        const next = keyword.trim()
        if (!next) {
          setTerm('')
          setMode('area')
          return
        }
        setTerm(next)
        setMode('search')
        if (next === term) setNonce((n) => n + 1)
      }

      return h(
        'div',
        { className: 'sl-root' },
        /* ------------------------------ top bar ------------------------------ */
        h(
          'div',
          { className: 'sl-topbar' },
          h('span', { className: 'sl-brand' }, icon('broadcast', 16), h('span', null, t('page.title'))),
          h(
            'div',
            { className: 'sl-searchbox' },
            icon('search', 14),
            h('input', {
              className: 'sl-search',
              value: keyword,
              placeholder: t('page.searchPlaceholder'),
              onChange: (e) => setKeyword(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') submitSearch()
                if (e.key === 'Escape' && mode === 'search') {
                  setKeyword('')
                  setTerm('')
                  setMode('area')
                }
              },
            }),
            keyword
              ? h(
                  'button',
                  {
                    className: 'sl-clear',
                    onClick: () => {
                      setKeyword('')
                      setTerm('')
                      setMode('area')
                    },
                    'aria-label': t('page.close'),
                  },
                  icon('close', 12, true),
                )
              : null,
          ),
          h(
            'button',
            {
              className: 'sl-btn',
              onClick: () => setNonce((n) => n + 1),
              title: t('page.refresh'),
              'aria-label': t('page.refresh'),
            },
            icon('refresh', 15, true),
          ),
          h(
            'button',
            {
              className: 'sl-btn sl-me-btn',
              onClick: () => setMeOpen(true),
              title: t('me.button'),
              'aria-label': t('me.button'),
            },
            icon('user', 15, true),
          ),
        ),

        /* --------------------------- platform row --------------------------- */
        h(
          'div',
          { className: 'sl-platforms', role: 'tablist' },
          sites.map((s) =>
            h(
              'button',
              {
                key: s.id,
                role: 'tab',
                'aria-selected': mode !== 'follow' && s.id === platform,
                className:
                  'sl-pf' + (mode !== 'follow' && s.id === platform ? ' is-on' : ''),
                style: { '--sl-accent': s.accent || 'var(--dsw-alias-brand-primary,#4176E6)' },
                onClick: () => {
                  setPlatform(s.id)
                  setMode('area')
                },
              },
              h('span', { className: 'sl-pf-dot' }),
              h('span', null, s.name),
            ),
          ),
          h(
            'button',
            {
              role: 'tab',
              'aria-selected': mode === 'follow',
              className: 'sl-pf sl-pf-follow' + (mode === 'follow' ? ' is-on' : ''),
              onClick: () => setMode('follow'),
            },
            heart(13, mode === 'follow'),
            h('span', null, t('page.tab.follow')),
          ),
        ),

        /* --------------------------- category rows -------------------------- */
        mode === 'area' && cats.length
          ? h(
              'div',
              { className: 'sl-catbar' },
              h(
                'div',
                { className: 'sl-cat-row' },
                cats.map((c) =>
                  h(
                    'button',
                    {
                      key: c.id,
                      className: 'sl-chip' + (parent && String(c.id) === String(parent.id) ? ' is-on' : ''),
                      onClick: () => setArea(firstArea([c])),
                    },
                    c.name,
                  ),
                ),
              ),
              children.length
                ? h(
                    'div',
                    { className: 'sl-cat-row is-sub' },
                    children.map((c) =>
                      h(
                        'button',
                        {
                          key: c.id,
                          className:
                            'sl-chip is-sub' + (String(area) === String(parent.id) + ':' + String(c.id) ? ' is-on' : ''),
                          onClick: () => setArea(String(parent.id) + ':' + String(c.id)),
                        },
                        c.name || t('page.all'),
                      ),
                    ),
                  )
                : null,
            )
          : null,

        /* ------------------------------ body ------------------------------- */
        h(
          'div',
          { className: 'sl-body' },
          mode === 'search'
            ? h(
                'div',
                { className: 'sl-searchline' },
                h('span', null, t('page.searching') + '：' + term),
                h(
                  'button',
                  {
                    className: 'sl-link',
                    onClick: () => {
                      setKeyword('')
                      setTerm('')
                      setMode('area')
                    },
                  },
                  t('page.backToArea'),
                ),
              )
            : null,

          openError
            ? h(
                'div',
                { className: 'sl-note is-warn' },
                openError,
                h('button', { className: 'sl-link', onClick: () => setOpenError('') }, t('page.close')),
              )
            : null,

          error
            ? h(
                'div',
                { className: 'sl-state' },
                h('div', { className: 'sl-state-title' }, t('page.failed')),
                h('div', { className: 'sl-state-msg' }, error),
                h('button', { className: 'sl-btn-primary', onClick: () => setNonce((n) => n + 1) }, t('page.retry')),
              )
            : h(
                'div',
                { className: 'sl-scroll' },
                list.length
                  ? h(
                      'div',
                      { className: 'sl-grid' },
                      list.map(card),
                    )
                  : h(
                      'div',
                      { className: 'sl-state' },
                      h(
                        'div',
                        { className: 'sl-state-title' },
                        loading
                          ? t('page.loading')
                          : mode === 'follow'
                            ? t('page.emptyFollow')
                            : mode === 'search'
                              ? t('page.emptySearch')
                              : t('page.empty'),
                      ),
                    ),
                moreFlag
                  ? h(
                      'button',
                      { className: 'sl-more', onClick: more, disabled: loading },
                      loading ? t('page.loading') : t('page.loadMore'),
                    )
                  : null,
              ),
        ),

        playing && playing.detail
          ? h(Player, {
              detail: playing.detail,
              settings,
              onClose: () => setPlaying(null),
              onPatchSettings: patchSettings,
            })
          : null,

        meOpen
          ? h(MeDialog, {
              sites,
              platform,
              settings,
              onClose: () => setMeOpen(false),
              onPatchSettings: patchSettings,
              onOpenRoom: openRoom,
            })
          : null,
      )
    }

    /* -------------------------------------------------------------- mount --- */

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'sl-root' },
            h('div', { className: 'sl-state' }, h('div', { className: 'sl-state-msg' }, message(this.state.error))),
          )
        }
        return this.props.children
      }
    }

    function mount(ctx, name, registration, component) {
      ctx.effect(() => {
        const dispose = ctx.slots.inject(name, () => ctx.slots.register(registration, component))
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      })
    }

    /* ---------------------------------------------------------------- css --- */

    const CSS = [
      '.sl-root{--sl-brand:#4d6bfe;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#141417);color:var(--dsw-alias-label-primary,#f4f4f5);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:20px;isolation:isolate}',
      '.sl-root input{user-select:text}',
      '.sl-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176E6);outline-offset:2px}',
      '.sl-root button{font:inherit;color:inherit}',
      /* top bar */
      '.sl-topbar{display:flex;align-items:center;gap:10px;flex:none;height:46px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}',
      '.sl-brand{display:flex;align-items:center;gap:7px;font-weight:600;flex:none;color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-brand svg{color:var(--dsw-alias-brand-primary,#4176E6)}',
      '.sl-searchbox{position:relative;flex:1;max-width:420px;margin:0 auto}',
      '.sl-searchbox>svg{position:absolute;left:10px;top:9px;color:var(--dsw-alias-label-secondary,#a1a1aa);pointer-events:none}',
      '.sl-search{width:100%;height:32px;padding:0 28px 0 30px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,#f4f4f5);font-size:13px;outline:none}',
      '.sl-search::placeholder{color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-search:focus{border-color:var(--sl-brand,#4d6bfe)}',
      '.sl-clear{position:absolute;right:5px;top:7px;display:flex;align-items:center;justify-content:center;width:18px;height:18px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);cursor:pointer}',
      '.sl-clear:hover{color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);cursor:pointer;flex:none}',
      '.sl-btn:hover{color:var(--dsw-alias-label-primary,#f4f4f5);border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.32))}',
      '.sl-btn.is-on{color:var(--sl-brand,#4d6bfe);border-color:var(--sl-brand,#4d6bfe)}',
      '.sl-me-btn{margin-left:2px}',
      /* platform row */
      '.sl-platforms{display:flex;align-items:center;gap:4px;flex:none;flex-wrap:wrap;padding:8px 12px 4px}',
      '.sl-pf{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:13px;cursor:pointer;white-space:nowrap}',
      '.sl-pf:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-pf-dot{width:7px;height:7px;border-radius:50%;background:var(--sl-accent,var(--dsw-alias-brand-primary,#4176E6));opacity:.55}',
      '.sl-pf.is-on{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#f4f4f5);font-weight:600}',
      '.sl-pf.is-on .sl-pf-dot{opacity:1}',
      '.sl-pf-follow{margin-left:6px}',
      /* category rows */
      '.sl-catbar{flex:none;display:flex;flex-direction:column;gap:4px;padding:2px 12px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}',
      '.sl-cat-row{display:flex;flex-wrap:wrap;gap:4px;max-height:56px;overflow-y:auto}',
      '.sl-cat-row.is-sub{max-height:48px}',
      '.sl-chip{height:24px;padding:0 9px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px;cursor:pointer;white-space:nowrap}',
      '.sl-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-chip.is-sub{height:22px;font-size:12px}',
      '.sl-chip.is-on{background:color-mix(in srgb,var(--sl-brand,#4d6bfe) 16%,transparent);border-color:color-mix(in srgb,var(--sl-brand,#4d6bfe) 32%,transparent);color:var(--sl-brand,#4d6bfe);font-weight:600}',
      /* body / scroll / grid */
      '.sl-body{display:flex;flex-direction:column;flex:1;min-height:0}',
      '.sl-searchline{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}',
      '.sl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(186px,1fr));gap:12px;padding:10px 12px 4px;align-items:start;align-content:start}',
      '.sl-card{position:relative;display:flex;flex-direction:column;align-self:start;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));cursor:pointer;transition:border-color .15s,transform .15s}',
      '.sl-card:hover{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.34));transform:translateY(-1px)}',
      '.sl-card.is-busy{opacity:.6}',
      '.sl-cover{position:relative;flex:none;width:100%;aspect-ratio:16/10;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));overflow:hidden}',
      '.sl-cover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.sl-cover-ph{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--dsw-alias-label-secondary,#a1a1aa);opacity:.5}',
      '.sl-badge{position:absolute;top:6px;left:6px;display:inline-flex;align-items:center;gap:4px;height:17px;padding:0 6px;border-radius:5px;background:rgba(232,56,84,.92);color:#fff;font-size:10px;line-height:1;font-weight:600}',
      '.sl-dot{width:5px;height:5px;border-radius:50%;background:#fff;animation:sl-blink 1.4s ease-in-out infinite}',
      '@keyframes sl-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '.sl-online{position:absolute;right:6px;bottom:6px;height:17px;padding:0 6px;border-radius:5px;background:rgba(0,0,0,.62);color:#fff;font-size:10px;line-height:17px}',
      '.sl-info{display:flex;flex-direction:column;gap:2px;padding:7px 8px 8px;min-width:0}',
      '.sl-name{font-size:12px;line-height:16px;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.sl-sub{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);min-width:0}',
      '.sl-anchor{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sl-area{flex:none;opacity:.7}',
      '.sl-fav{position:absolute;right:5px;bottom:5px;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);cursor:pointer}',
      '.sl-fav:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));color:var(--dsw-alias-state-error-primary,#e83854)}',
      '.sl-fav.is-on{color:var(--dsw-alias-state-error-primary,#e83854)}',
      '.sl-more{flex:none;margin:6px 12px 16px;height:34px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);cursor:pointer}',
      '.sl-more:hover{color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-state{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-state-title{font-size:13px}',
      '.sl-state-msg{font-size:12px;max-width:440px;word-break:break-word;opacity:.8}',
      '.sl-btn-primary{height:30px;padding:0 14px;border:0;border-radius:8px;background:var(--sl-brand,#4d6bfe);color:#fff;font-size:12px;font-weight:600;letter-spacing:.2px;cursor:pointer;flex:none;transition:filter .15s ease,box-shadow .15s ease}',
      '.sl-btn-primary:hover:not(:disabled){filter:brightness(1.08);box-shadow:0 2px 8px color-mix(in srgb,var(--sl-brand,#4d6bfe) 34%,transparent)}',
      '.sl-btn-primary:active:not(:disabled){filter:brightness(.96)}',
      '.sl-btn-primary:disabled{opacity:.5;cursor:default}',
      '.sl-note{flex:none;display:flex;align-items:center;gap:8px;margin:6px 12px 0;padding:6px 10px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1))}',
      '.sl-note.is-warn{color:var(--dsw-alias-state-warn-primary,#f5a524)}',
      '.sl-link{border:0;background:transparent;color:var(--sl-brand,#4d6bfe);cursor:pointer;font-size:12px;white-space:nowrap}',
      /* player */
      '.sl-player{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#141417)}',
      '.sl-phead{display:flex;align-items:center;gap:10px;flex:none;height:44px;padding:0 10px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}',
      '.sl-ptitle{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.sl-psub{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-pquals{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end;max-height:32px;overflow:hidden}',
      '.sl-q{height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:11px;cursor:pointer;white-space:nowrap}',
      '.sl-q:hover{color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-q.is-on{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.18));border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.34));color:var(--dsw-alias-label-primary,#f4f4f5);font-weight:600}',
      '.sl-pbody{display:flex;flex:1;min-height:0}',
      '.sl-pstage{position:relative;display:flex;flex:1;min-width:0;min-height:0;align-items:center;justify-content:center;background:#000;overflow:hidden}',
      '.sl-pstage video{width:100%;height:100%;object-fit:contain;background:#000}',
      '.sl-bullets{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2}',
      '.sl-bullet{position:absolute;left:100%;white-space:nowrap;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 3px rgba(0,0,0,.7);animation-name:sl-fly;animation-timing-function:linear;animation-fill-mode:forwards;will-change:transform}',
      '@keyframes sl-fly{from{transform:translateX(0)}to{transform:translateX(calc(-100vw - 100%))}}',
      '.sl-hint{position:absolute;color:#d4d4d8;font-size:12px;z-index:3}',
      '.sl-perr{position:absolute;left:0;right:0;bottom:0;padding:6px 12px;background:rgba(0,0,0,.66);color:var(--dsw-alias-state-warn-primary,#f5a524);font-size:12px;z-index:3}',
      '.sl-dan{flex:none;width:264px;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}',
      '.sl-dan-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;height:34px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));font-size:12px;font-weight:600}',
      '.sl-dan-state{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}',
      '.sl-dan-state.is-on{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.sl-dan-list{flex:1;min-height:0;overflow-y:auto;padding:6px 10px;display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:17px}',
      '.sl-dan-item{word-break:break-word}',
      '.sl-dan-item.is-gift{color:var(--dsw-alias-state-warn-primary,#f5a524)}',
      '.sl-dan-user{color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-dan-text{color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-dan-empty{color:var(--dsw-alias-label-secondary,#a1a1aa);opacity:.7;padding:10px 0;text-align:center}',
      /* me dialog */
      '.sl-me-mask{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}',
      '.sl-me{display:flex;flex-direction:column;width:min(560px,calc(100% - 40px));max-height:calc(100% - 48px);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#1c1c20);box-shadow:0 18px 48px rgba(0,0,0,.45);overflow:hidden}',
      '.sl-me-head{display:flex;align-items:center;justify-content:space-between;flex:none;height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}',
      '.sl-me-title{display:flex;align-items:center;gap:7px;font-weight:600}',
      '.sl-me-tabs{display:flex;gap:2px;flex:none;padding:8px 10px 0;flex-wrap:wrap}',
      '.sl-me-tab{height:28px;padding:0 11px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px;cursor:pointer}',
      '.sl-me-tab:hover{color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-me-tab.is-on{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary,#f4f4f5);font-weight:600}',
      '.sl-me-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 16px}',
      '.sl-me-sec{display:flex;flex-direction:column;gap:10px}',
      '.sl-me-tip{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-me-row{display:flex;gap:8px;align-items:center}',
      '.sl-input{flex:1;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,#f4f4f5);font-size:12px;outline:none}',
      '.sl-input:focus{border-color:var(--sl-brand,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--sl-brand,#4d6bfe) 16%,transparent)}',
      '.sl-me-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#e83854)}',
      '.sl-me-empty{font-size:12px;color:var(--dsw-alias-label-secondary,#a1a1aa);padding:16px 0;text-align:center}',
      '.sl-me-hist{display:flex;flex-direction:column;gap:6px}',
      '.sl-me-hist-item{display:flex;align-items:center;gap:10px;padding:6px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07))}',
      '.sl-me-hist-cover{width:56px;height:34px;flex:none;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-layer-2,#2a2a2e)}',
      '.sl-me-hist-info{flex:1;min-width:0}',
      '.sl-me-hist-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sl-me-hist-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa)}',
      '.sl-me-clear{align-self:flex-start;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px;cursor:pointer}',
      '.sl-me-clear:hover{color:var(--dsw-alias-label-primary,#f4f4f5)}',
      '.sl-me-acc{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07))}',
      '.sl-me-acc-head{display:flex;align-items:center;gap:8px}',
      '.sl-me-acc-name{font-weight:600;font-size:12px}',
      '.sl-me-acc-badge{font-size:11px;color:var(--dsw-alias-label-secondary,#a1a1aa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sl-me-acc-badge.is-on{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.sl-me-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}',
      '.sl-me-setting input[type=range]{flex:1;max-width:220px}',
      '.sl-side{display:inline-flex;align-items:center;justify-content:center;color:inherit}',
    ].join('')

    /* --------------------------------------------------------------- apply -- */

    function apply(ctx) {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => {
          const dispose = ctx.locale.register(NS, DICTS)
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        })
        if (typeof ctx.locale.bind === 'function') translate = ctx.locale.bind(NS)
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NS
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      })

      mount(
        ctx,
        'sidebar.panellist',
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          label: () => t('nav.label'),
        },
        SideIcon,
      )

      mount(ctx, 'main', { name: 'main', key: PANEL_ID }, () => h(Boundary, null, h(Panel)))
    }

    return { name: NS, inject: ['slots', 'locale'], apply }
  },
})
