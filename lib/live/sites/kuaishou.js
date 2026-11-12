/**
 * 快手 live adapter. See CONTRACT.md at the plugin root.
 *
 * 移植自 dart_simple_live 的 simple_live_core/lib/src/kuaishou_site.dart 的
 * 正常功能路径（未移植限流协调器 / 验证码 / 多账号兜底）：
 *   分类  live_api/category/data?type=1..8
 *   列表  live_api/gameboard/list（父级 1-5） / non-gameboard/list（父级 6-8）
 *   搜索  live_api/search/liveStream（匿名常返回空 → 回退本地筛选 / search/author）
 *   详情  匿名房间页 https://live.kuaishou.com/u/<authorId> 的
 *         window.__INITIAL_STATE__.liveroom.playList[].liveStream
 *         .hlsPlayUrl（真 HLS）+ h264.playUrls.adaptationSet.representation（FLV）
 *
 * 全部走公开/匿名接口，无需 __NS_sig3 之类原生签名；带用户 cookie 时
 * http 会自动注入，登录态下接口成功率更高。
 *
 * @module dsh-simple-live/lib/live/sites/kuaishou
 */

export const id = 'kuaishou'
export const name = '快手'
export const accent = '#ff5000'
export const playHeaders = { referer: 'https://live.kuaishou.com/', origin: 'https://live.kuaishou.com' }

const REFERER = 'https://live.kuaishou.com/'
const API = 'https://live.kuaishou.com/live_api'
const PAGE_SIZE = 20
const JSON_HEADERS = { accept: 'application/json, text/plain, */*' }

/** 8 个顶级分区，与站点 liveMaskTabList / dart _emptyCategoryRoots 一致 */
const ROOTS = [
  { id: '1', name: '热门' },
  { id: '2', name: '网游' },
  { id: '3', name: '单机' },
  { id: '4', name: '手游' },
  { id: '5', name: '棋牌' },
  { id: '6', name: '娱乐' },
  { id: '7', name: '综合' },
  { id: '8', name: '文化' },
]

function absUrl(u) {
  const s = String(u ?? '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  if (/^https?:\/\//i.test(s)) return s
  return `https://${s}`
}

function isImageUrl(u) {
  return /\.(svgz?|png|ico|avif|tiff?|jfif|jpe?g|webp|bmp|gif)(\?|$)/i.test(String(u ?? ''))
}

/** 快手常给没后缀的封面地址，补 .jpg 才能显示 */
function coverUrl(u) {
  const s = absUrl(u)
  if (!s) return ''
  return isImageUrl(s) ? s : `${s}.jpg`
}

/**
 * 快手房间页偶发把 `&tsc=origin` 拼成 `tsc=origin`（掉了一个 &），
 * 签名 wsSecret 覆盖完整 query，缺 & 会让 CDN 直接 403 —— 补回去才能播。
 */
function normalizeHls(u) {
  return absUrl(u).replace(/([^&?])tsc=origin/, '$1&tsc=origin')
}

/** "7749" / "2.9w" / 7749 -> number */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v ?? '').trim()
  if (!s) return 0
  const m = s.match(/^([\d.]+)\s*(万|w|W)?/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return Math.round(m[2] ? n * 10000 : n)
}

function withPrefix(msg, err) {
  const detail = err && err.message ? err.message : String(err)
  return new Error(`${msg}：${detail}`)
}

function pageOf(page) {
  const p = Math.floor(Number(page))
  return Number.isFinite(p) && p > 0 ? p : 1
}

/** 取第一个非空文本（空串/undefined/null 都跳过） */
function firstText(...vals) {
  for (const v of vals) {
    if (v == null) continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

/** 从房间页 HTML 里抠出 window.__INITIAL_STATE__ 的 JSON（按花括号配平，避免截断） */
function extractState(html) {
  const marker = 'window.__INITIAL_STATE__='
  let i = html.indexOf(marker)
  if (i < 0) return null
  i += marker.length
  let depth = 0
  let start = -1
  let end = -1
  for (let k = i; k < html.length; k++) {
    const c = html[k]
    if (c === '{') {
      if (start < 0) start = k
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  if (start < 0 || end < 0) return null
  const raw = html.slice(start, end).replace(/\bundefined\b/g, 'null')
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 列表项 -> Room */
function listItemToRoom(item) {
  if (!item || typeof item !== 'object') return null
  const author = item.author || {}
  const roomId = String(author.id ?? item.authorId ?? item.userId ?? '').trim()
  if (!roomId) return null
  const gameInfo = item.gameInfo || {}
  const cover = item.poster || gameInfo.poster || author.avatar || ''
  return {
    platform: id,
    roomId,
    title: String(item.caption ?? item.title ?? author.name ?? ''),
    cover: coverUrl(cover),
    anchor: String(author.name ?? ''),
    areaName: String(gameInfo.name ?? ''),
    online: toNum(item.watchingCount),
    live: item.living !== false || !!(item.playUrls && JSON.stringify(item.playUrls).includes('http')),
  }
}

/* ------------------------------------------------------------------ 分类 */

async function subCategories(http, rootId) {
  const out = []
  const seen = new Set()
  // ponytail: 每个分区最多翻 3 页（150 个子分区），够用；不够再加
  for (let page = 1; page <= 3; page++) {
    const url = `${API}/category/data?type=${encodeURIComponent(rootId)}&page=${page}&size=50`
    let body
    try {
      body = await http.json(url, { referer: REFERER, headers: JSON_HEADERS })
    } catch (e) {
      throw withPrefix('快手分区目录获取失败', e)
    }
    const data = body?.data
    if (!data || !Array.isArray(data.list)) throw new Error('快手分区目录响应格式错误')
    for (const s of data.list) {
      if (!s || s.id == null) continue
      const key = String(s.id)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: key, name: String(s.name ?? '') })
    }
    if (!data.hasMore) break
  }
  return out
}

export async function categories(http) {
  let lists
  try {
    lists = await Promise.all(ROOTS.map((r) => subCategories(http, r.id)))
  } catch (e) {
    throw withPrefix('快手分类获取失败', e)
  }
  return ROOTS.map((r, idx) => {
    const area = { id: r.id, name: r.name }
    if (lists[idx].length) area.children = lists[idx]
    return area
  })
}

/* ------------------------------------------------------------------ 列表 */

/** area 形如 "6:1000004"（父级:子分区） */
function parseArea(area) {
  const s = String(area ?? '').trim()
  if (!s) return { parent: null, sub: '' }
  if (s.includes(':')) {
    const [p, ...rest] = s.split(':')
    return { parent: Number(p), sub: rest.join(':') }
  }
  return { parent: null, sub: s }
}

async function board(http, kind, gameId, page) {
  const url = `${API}/${kind}/list?filterType=0&pageSize=${PAGE_SIZE}&gameId=${encodeURIComponent(gameId)}&page=${page}`
  const body = await http.json(url, { referer: REFERER, headers: JSON_HEADERS })
  const data = body?.data
  if (!data || !Array.isArray(data.list)) throw new Error('快手分区直播间响应格式错误')
  return data
}

export async function rooms(http, { area, page } = {}) {
  const { parent, sub } = parseArea(area)
  if (!sub) throw new Error('快手房间列表获取失败：缺少分区 ID')
  const p = pageOf(page)
  const kind = parent && parent >= 1 && parent <= 5 ? 'gameboard' : 'non-gameboard'

  let data
  try {
    data = await board(http, kind, sub, p)
    // 父级未知且空页时，换另一个 board 再试一次
    if (!parent && !data.list.length) {
      const alt = kind === 'gameboard' ? 'non-gameboard' : 'gameboard'
      const d2 = await board(http, alt, sub, p)
      if (d2.list.length) data = d2
    }
  } catch (e) {
    throw withPrefix('快手房间列表获取失败', e)
  }

  const items = data.list.map(listItemToRoom).filter(Boolean)
  const hasMore = data.hasMore != null ? !!data.hasMore : items.length >= PAGE_SIZE
  return { items, hasMore }
}

/* ------------------------------------------------------------------ 搜索 */

/** 从播放地址对象里找第一条可播 URL（判断是否有流） */
function hasPlayable(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v)
}

async function searchStream(http, keyword, page) {
  const url = `${API}/search/liveStream?keyword=${encodeURIComponent(keyword)}&page=${page}&count=${PAGE_SIZE}&ussid=`
  const body = await http.json(url, {
    referer: `https://live.kuaishou.com/search?keyword=${encodeURIComponent(keyword)}`,
    headers: { ...JSON_HEADERS, referer: `https://live.kuaishou.com/search?keyword=${encodeURIComponent(keyword)}` },
  })
  const data = body?.data
  if (!data || !Array.isArray(data.list)) return { items: [], hasMore: false }
  const items = data.list.map(listItemToRoom).filter(Boolean)
  return { items, hasMore: data.hasMore != null ? !!data.hasMore : items.length >= PAGE_SIZE }
}

/** 匿名搜索常被限流返回空：回退为在推荐流里按关键词本地筛选 */
async function searchLocal(http, keyword) {
  const body = await http.json(`${API}/home/list`, { referer: REFERER, headers: JSON_HEADERS })
  const groups = body?.data?.list
  const kw = keyword.toLowerCase()
  const items = []
  const seen = new Set()
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const s of g?.gameLiveInfo ?? []) {
      for (const t of s?.liveInfo ?? []) {
        const room = listItemToRoom(t)
        if (!room || seen.has(room.roomId)) continue
        const hay = `${room.title} ${room.anchor} ${room.areaName}`.toLowerCase()
        if (!hay.includes(kw)) continue
        seen.add(room.roomId)
        items.push(room)
      }
    }
  }
  return { items, hasMore: false }
}

/** 最后兜底：按主播名搜索（可能返回未开播主播，仅保留 living 的） */
async function searchAuthor(http, keyword) {
  const url =
    `${API}/search/author?key=${encodeURIComponent(keyword)}&keyword=${encodeURIComponent(keyword)}` +
    `&page=1&count=15&ussid=&lssid=`
  const body = await http.json(url, {
    referer: `https://live.kuaishou.com/search?keyword=${encodeURIComponent(keyword)}`,
    headers: JSON_HEADERS,
  })
  const list = body?.data?.list
  const items = []
  for (const a of Array.isArray(list) ? list : []) {
    const roomId = String(a?.id ?? '').trim()
    if (!roomId || a.living === false) continue
    items.push({
      platform: id,
      roomId,
      title: String(a.name ?? ''),
      cover: coverUrl(a.avatar),
      anchor: String(a.name ?? ''),
      online: 0,
      live: a.living === true,
    })
  }
  return { items, hasMore: false }
}

export async function search(http, { keyword, page } = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw new Error('快手搜索失败：缺少关键词')
  const p = pageOf(page)

  try {
    const r = await searchStream(http, kw, p)
    if (r.items.length) return r
  } catch {
    /* 落到回退 */
  }
  if (p === 1) {
    for (const fn of [searchLocal, searchAuthor]) {
      try {
        const r = await fn(http, kw)
        if (r.items.length) return r
      } catch {
        /* 下一个回退 */
      }
    }
  }
  return { items: [], hasMore: false }
}

/* ------------------------------------------------------- 房间详情 + 清晰度 */

function pickRoom(playList, roomId) {
  const rooms = (Array.isArray(playList) ? playList : []).filter((x) => x && typeof x === 'object')
  if (!rooms.length) return null
  const match = rooms.filter((r) => String(r?.author?.id ?? '') === roomId)
  const pool = match.length ? match : rooms
  return pool.find((r) => r.isLiving === true) ?? pool[0]
}

function buildQualities(liveStream) {
  const ls = liveStream || {}
  const playUrls = ls.playUrls || {}
  // 常见形态：playUrls = { h264: { adaptationSet: { representation: [...] } }, hevc: {} }
  const h264 = playUrls.h264 || playUrls
  const reps = h264?.adaptationSet?.representation
  const list = []
  const seen = new Set()

  const push = (q) => {
    if (!q.url || seen.has(q.url)) return
    seen.add(q.url)
    list.push(q)
  }

  // HLS 优先（真 m3u8，auth_key 绑定具体路径，只能原样用）
  const hls = typeof ls.hlsPlayUrl === 'string' ? normalizeHls(ls.hlsPlayUrl) : ''
  if (hls) push({ name: '高清', url: hls, format: 'hls' })

  // FLV 各清晰度，按 level 从高到低
  const flv = (Array.isArray(reps) ? reps : [])
    .filter((r) => hasPlayable(r?.url))
    .map((r) => ({
      name: String(r.name || r.shortName || r.qualityType || `清晰度${r.level}`),
      level: Number(r.level) || 0,
      url: absUrl(r.url),
    }))
    .sort((a, b) => b.level - a.level)
  for (const r of flv) push({ name: r.name, url: r.url, format: 'flv' })

  return list
}

export async function room(http, { roomId } = {}) {
  const rid = String(roomId ?? '').trim()
  if (!/^[A-Za-z0-9_-]+$/.test(rid)) throw new Error('快手房间号无效')

  let html
  try {
    html = await http.text(`https://live.kuaishou.com/u/${encodeURIComponent(rid)}`, {
      referer: REFERER,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    })
  } catch (e) {
    throw withPrefix('快手房间信息获取失败', e)
  }

  const state = extractState(html)
  const liveroom = state?.liveroom
  const selected = pickRoom(liveroom?.playList, rid)
  if (!selected) throw new Error('快手房间信息获取失败：页面未返回直播间数据')

  const ls = selected.liveStream && typeof selected.liveStream === 'object' ? selected.liveStream : selected
  const author = selected.author || {}
  const gameInfo = selected.gameInfo || {}

  const qualities = buildQualities(ls)
  const live =
    selected.isLiving === true ||
    (!!ls.id && qualities.length > 0) ||
    qualities.length > 0

  const info = {
    platform: id,
    roomId: String(author.id ?? rid),
    title: firstText(
      selected.caption,
      selected.title,
      ls.caption,
      ls.title,
      author.name ? `${author.name}的直播` : '',
      gameInfo.name,
      `快手 ${rid}`,
    ),
    cover: coverUrl(ls.poster ?? selected.poster ?? gameInfo.poster ?? author.avatar),
    anchor: String(author.name ?? ''),
    areaName: String(gameInfo.name ?? ''),
    online: toNum(selected.watchingCount ?? ls.watchingCount ?? gameInfo.watchingCount),
    live,
  }
  info.qualities = live ? qualities : []
  return info
}
