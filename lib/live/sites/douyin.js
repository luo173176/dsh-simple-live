/**
 * 抖音 live adapter. See CONTRACT.md at the plugin root.
 *
 * 移植自 dart_simple_live 的 simple_live_core/lib/src/douyin_site.dart：
 * - cookie 引导：GET https://live.douyin.com/ 取 set-cookie 里的 ttwid/__ac_nonce/msToken；
 * - 分类：首页 SSR 里的 \"categoryData\":[...]（转义 JSON，用括号配平扫描取出）；
 * - 分区列表：webcast/web/partition/detail/room/v2/，URL 末尾必须补 &msToken=&a_bogus=
 *   —— 缺这两个空参数时抖音返回 200 + 0 字节的静默拦截；
 * - 房间详情：webcast/room/web/enter/ 在本机会话下返回 0 字节，故降级为直接抓直播间
 *   SSR 网页，取 \"state\":{...} 里的 roomStore.roomInfo.room（status / stream_url 都在）；
 * - 取流：hls_pull_url_map / flv_pull_url + live_core_sdk_data.pull_data.options.qualities。
 *
 * 签名说明：上游用 QuickJS 跑 645KB 混淆的 webmssdk 现算 a_bogus。这里不搬那个黑盒，
 * 改用「空 msToken/a_bogus 占位」+ SSR 网页降级，实测列表与取流都可用。
 *
 * @module dsh-simple-live/lib/live/sites/douyin
 */

export const id = 'douyin'
export const name = '抖音'
export const accent = '#fe2c55'
export const playHeaders = { referer: 'https://live.douyin.com/', origin: 'https://live.douyin.com' }

/** 上游用的 QQBrowser UA：换桌面 Chrome UA 拿不到完整 SSR 数据 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400'
const REFERER = 'https://live.douyin.com/'
const HOME = 'https://live.douyin.com/'
const LIST_API = 'https://live.douyin.com/webcast/web/partition/detail/room/v2/'
const SEARCH_API = 'https://www.douyin.com/aweme/v1/web/live/search/'
const REFLOW_API = 'https://webcast.amemv.com/webcast/room/reflow/info/'
const PAGE_SIZE = 15
const SEARCH_PAGE_SIZE = 10

/** 拿不到 ttwid 时的兜底（上游硬编码值，只用于列表/取流） */
const FALLBACK_COOKIE =
  'ttwid=1%7CB1qls3GdnZhUov9o2NxOMxxYS2ff6OSvEWbv0ytbES4%7C1680522049%7C280d802d6d478e3e78d0c807f7c487e7ffec0ae4e5fdd6a0fe74c3c6af149511'

/* ------------------------------------------------------------------ 小工具 */

function absUrl(u) {
  const s = String(u ?? '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  if (/^https?:\/\//i.test(s)) return s
  return `https://${s}`
}

/** 拉流地址统一走 https，避免播放器（https 页面）被判混合内容 */
function streamUrl(u) {
  const s = absUrl(u)
  return s.replace(/^http:\/\//i, 'https://')
}

/** "2万" / "28055" -> number */
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

/**
 * 从原始 HTML 里取一段配平的花括号/方括号片段。
 * 抖音把 JSON 塞进 JS 字符串，引号是 \" 这种转义形态，所以遇到反斜杠就跳过两字符，
 * 裸引号才切换字符串状态。
 */
function sliceBalanced(text, start, open = '{', close = '}') {
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

function parseEscapedJson(raw, label) {
  if (!raw) throw new Error(`${label}未找到`)
  try {
    return JSON.parse(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  } catch (e) {
    throw withPrefix(`${label}解析失败`, e)
  }
}

/* -------------------------------------------------------------- cookie 引导 */

let cookieCache = { value: '', at: 0 }
const COOKIE_TTL = 5 * 60 * 1000

/** 抖音的列表/取流都认 ttwid，共享 http 不存 cookie，这里自己引导并缓存 */
async function ensureCookie(http, force = false) {
  if (!force && cookieCache.value && Date.now() - cookieCache.at < COOKIE_TTL) return cookieCache.value
  try {
    const res = await http.request(HOME, {
      headers: { 'user-agent': UA, referer: REFERER, 'accept-language': 'zh-CN,zh;q=0.9' },
      timeout: 15000,
    })
    const jar = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []) ?? []
    await res.text().catch(() => '')
    const parts = jar
      .map((c) => String(c).split(';')[0].trim())
      .filter((c) => /^(ttwid|__ac_nonce|msToken)=/.test(c))
    const value = parts.length ? parts.join('; ') : ''
    if (!value.includes('ttwid=')) {
      cookieCache = { value: FALLBACK_COOKIE, at: Date.now() }
      return cookieCache.value
    }
    cookieCache = { value, at: Date.now() }
    return value
  } catch {
    cookieCache = { value: FALLBACK_COOKIE, at: Date.now() }
    return cookieCache.value
  }
}

/* ------------------------------------------------------------------ 分类 */

export async function categories(http) {
  let html
  try {
    const cookie = await ensureCookie(http)
    html = await http.text(HOME, {
      headers: { 'user-agent': UA, cookie, 'accept-language': 'zh-CN,zh;q=0.9' },
      referer: REFERER,
      timeout: 20000,
    })
  } catch (e) {
    throw withPrefix('抖音分类获取失败', e)
  }

  const key = 'categoryData\\":'
  const at = html.indexOf(key)
  if (at < 0) throw new Error('抖音分类获取失败：首页未包含分类数据')
  const arrStart = html.indexOf('[', at + key.length)
  const data = parseEscapedJson(sliceBalanced(html, arrStart, '[', ']'), '抖音分类获取失败：分类数据')

  const list = Array.isArray(data) ? data : []
  const out = []
  for (const item of list) {
    const p = item?.partition
    if (!p) continue
    const pid = `${p.id_str},${p.type}`
    const pname = String(p.title ?? '')
    const children = []
    // 上游把父分区自己塞进子分区首位，方便直接进「全部」
    children.push({ id: pid, name: pname })
    for (const sub of Array.isArray(item.sub_partition) ? item.sub_partition : []) {
      const sp = sub?.partition
      if (!sp) continue
      children.push({ id: `${sp.id_str},${sp.type}`, name: String(sp.title ?? '') })
    }
    out.push({ id: pid, name: pname, children })
  }
  if (!out.length) throw new Error('抖音分类获取失败：分类数据为空')
  return out
}

/* ------------------------------------------------------------------ 列表 */

export async function rooms(http, { area, page } = {}) {
  if (area === undefined || area === null || area === '') throw new Error('抖音房间列表获取失败：缺少分区 ID')
  const p = pageOf(page)
  // 面板传来的是 `parent:sub`；抖音的分区 id 本身形如 `101,4`（含逗号），取末段。
  const areaRaw = String(area).includes(':') ? String(area).split(':').pop() : String(area)
  const [partition, partitionType = '4'] = areaRaw.split(',')

  const qs = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'link_share',
    cookie_enabled: 'true',
    screen_width: '1980',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Edge',
    browser_version: '125.0.0.0',
    browser_online: 'true',
    count: String(PAGE_SIZE),
    offset: String((p - 1) * PAGE_SIZE),
    partition,
    partition_type: partitionType,
    req_from: '2',
  })

  let body
  try {
    const cookie = await ensureCookie(http)
    // 末尾这两个空参数不能省：缺了抖音静默返回 0 字节
    const payload = await http.text(`${LIST_API}?${qs}&msToken=&a_bogus=`, {
      headers: { 'user-agent': UA, cookie },
      referer: `${REFERER}${partition}`,
      timeout: 20000,
    })
    if (!payload.trim()) throw new Error('接口返回空响应（风控静默拦截，检查 msToken/a_bogus 占位参数）')
    try {
      body = JSON.parse(payload)
    } catch {
      throw new Error(`接口返回非 JSON：${payload.slice(0, 80)}`)
    }
  } catch (e) {
    throw withPrefix('抖音房间列表获取失败', e)
  }

  const raw = Array.isArray(body?.data?.data) ? body.data.data : []
  const items = raw
    .map((x) => {
      const r = x?.room ?? {}
      const webRid = String(x?.web_rid ?? r.owner?.web_rid ?? '')
      if (!webRid) return null
      const stats = r.room_view_stats ?? {}
      return {
        platform: id,
        roomId: webRid,
        title: String(r.title ?? ''),
        cover: absUrl(r.cover?.url_list?.[0]),
        anchor: String(r.owner?.nickname ?? ''),
        online: toNum(stats.display_value ?? stats.display_short),
        // 分区列表里的 room.status 恒为 0（实测），但能出现在这里的都是开播中
        live: true,
      }
    })
    .filter(Boolean)

  return { items, hasMore: raw.length >= PAGE_SIZE }
}

/* ------------------------------------------------------------------ 搜索 */

/**
 * 搜索接口实测被登录态卡住（status_code 2483「请先登录」），这一条是抖音平台的墙，
 * 与签名无关。这里做两层降级：纯数字关键词按房间号直达，其余给出可读原因。
 */
export async function search(http, { keyword, page } = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw new Error('抖音搜索失败：缺少关键词')
  const p = pageOf(page)

  const qs = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    search_channel: 'aweme_live',
    keyword: kw,
    search_source: 'switch_tab',
    query_correct_type: '1',
    is_filter_search: '0',
    from_group_id: '',
    offset: String((p - 1) * SEARCH_PAGE_SIZE),
    count: String(SEARCH_PAGE_SIZE),
    pc_client_type: '1',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: '1980',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Edge',
    browser_version: '125.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '125.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    cpu_core_num: '12',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '100',
    webid: '7382872326016435738',
  })

  let body = null
  try {
    const cookie = await ensureCookie(http)
    body = await http.json(`${SEARCH_API}?${qs}`, {
      headers: { 'user-agent': UA, cookie, accept: 'application/json, text/plain, */*' },
      referer: `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=live`,
      timeout: 15000,
    })
  } catch {
    body = null
  }

  const rows = Array.isArray(body?.data) ? body.data : []
  const items = []
  for (const row of rows) {
    const raw = row?.lives?.rawdata
    if (typeof raw !== 'string' || !raw) continue
    let live
    try {
      live = JSON.parse(raw)
    } catch {
      continue
    }
    const webRid = String(live?.owner?.web_rid ?? '')
    if (!webRid) continue
    items.push({
      platform: id,
      roomId: webRid,
      title: String(live.title ?? ''),
      cover: absUrl(live.cover?.url_list?.[0]),
      anchor: String(live.owner?.nickname ?? ''),
      online: toNum(live.stats?.total_user),
      live: true,
    })
  }
  if (items.length) return { items, hasMore: rows.length >= SEARCH_PAGE_SIZE }

  // 降级一：像房间号的，直接按房间号解析
  if (/^\d{5,20}$/.test(kw)) {
    const { qualities, ...detail } = await room(http, { roomId: kw })
    return { items: [detail], hasMore: false }
  }

  // 降级二：把真实原因说清楚
  const status = body?.status_code
  const msg = body?.status_msg || (typeof body === 'string' ? body : '')
  const why = status === 2483 || /登录/.test(String(msg)) ? '需要登录态（status_code 2483 请先登录）' : String(msg || '接口无返回')
  throw new Error(`抖音搜索失败：Web 搜索接口${why}，可直接输入房间号进入`)
}

/* ------------------------------------------------------- 房间详情 + 清晰度 */

/** sdk_key -> hls_pull_url_map / flv_pull_url 的键名（实测对应关系） */
const SDK_MAP_KEYS = {
  origin: ['FULL_HD1', 'ORIGIN', 'FULL_HD'],
  uhd: ['FULL_HD1', 'UHD', 'FULL_HD'],
  hd: ['HD1', 'HD'],
  sd: ['SD2', 'SD1'],
  ld: ['SD1', 'LD1'],
}

const mapKeyLevel = { FULL_HD1: 5, ORIGIN: 5, UHD: 4, HD1: 3, HD: 3, SD2: 2, SD1: 1, LD1: 1 }

function pickFromMap(map, sdkKey) {
  if (!sdkKey || !map || typeof map !== 'object') return ''
  for (const key of SDK_MAP_KEYS[sdkKey] ?? []) {
    if (map[key]) return String(map[key])
  }
  // 兜底：按 URL 里的 _uhd/_hd/_sd/_ld 路径段认档位（_hd 不会误命中 _uhd）
  const hit = new RegExp(`_${sdkKey}[/_.]`, 'i')
  for (const value of Object.values(map)) {
    if (hit.test(String(value))) return String(value)
  }
  return ''
}

/** 新版前端会把每档的 hls/flv 直接写进 stream_data（网页 SSR 里是 "$13" 反引用） */
function parseStreamData(raw) {
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed?.data && typeof parsed.data === 'object' ? parsed.data : null
  } catch {
    return null
  }
}

function qualitiesFrom(su) {
  if (!su || typeof su !== 'object') return []
  const hlsMap = su.hls_pull_url_map
  const flvMap = su.flv_pull_url
  const pull = su.live_core_sdk_data?.pull_data
  const options = Array.isArray(pull?.options?.qualities) ? pull.options.qualities : []
  const structured = parseStreamData(pull?.stream_data)

  const collected = []
  const add = (level, label, url, format) => {
    const u = streamUrl(url)
    if (!u) return
    collected.push({ level: Number(level) || 0, name: label, url: u, format })
  }

  const list = options.length
    ? options
    : Object.keys({ ...(hlsMap ?? {}), ...(flvMap ?? {}) }).map((k) => ({
        name: k,
        sdk_key: '',
        level: mapKeyLevel[k] ?? 0,
        mapKey: k,
      }))

  for (const q of list) {
    const sdkKey = String(q.sdk_key ?? '')
    const label = String(q.name ?? sdkKey ?? '清晰度')
    const level = Number(q.level) || mapKeyLevel[q.mapKey] || 0
    const node = sdkKey && structured ? structured[sdkKey]?.main : null
    const hls = node?.hls || pickFromMap(hlsMap, sdkKey) || (q.mapKey ? hlsMap?.[q.mapKey] : '')
    const flv = node?.flv || pickFromMap(flvMap, sdkKey) || (q.mapKey ? flvMap?.[q.mapKey] : '')
    if (hls) add(level, label, hls, 'hls')
    else if (flv) add(level, label, flv, 'flv')
  }

  if (!collected.length && su.hls_pull_url) add(mapKeyLevel.FULL_HD1, '原画', su.hls_pull_url, 'hls')

  // 同一路流可能被 原画/蓝光 共用，按 URL 去重保留最高档
  const byUrl = new Map()
  for (const q of collected) {
    const prev = byUrl.get(q.url)
    if (!prev || q.level > prev.level) byUrl.set(q.url, q)
  }
  return [...byUrl.values()]
    .sort((a, b) => b.level - a.level)
    .map((q) => ({ name: q.name, url: q.url, format: q.format }))
}

/** 19 位 roomId -> 主播 web_rid（reflow 接口无需签名） */
async function webRidByRoomId(http, roomId) {
  const url = `${REFLOW_API}?type_id=0&live_id=1&room_id=${encodeURIComponent(roomId)}&sec_user_id=&version_code=99.99.99&app_id=6383`
  let body
  try {
    const cookie = await ensureCookie(http)
    body = await http.json(url, { headers: { 'user-agent': UA, cookie }, referer: REFERER })
  } catch (e) {
    throw withPrefix('抖音房间号转换失败', e)
  }
  const webRid = body?.data?.room?.owner?.web_rid
  if (!webRid) throw new Error('抖音房间号转换失败：未找到对应的主播房间号')
  return String(webRid)
}

/**
 * 直播间 SSR 网页里取 state。
 * 网页是 \{\\"state\\":{\\"appStore... 这种双重转义，配平扫描 + 反转义后就能 JSON.parse。
 */
async function roomState(http, webRid) {
  let html
  try {
    const cookie = await ensureCookie(http)
    html = await http.text(`${REFERER}${webRid}`, {
      headers: { 'user-agent': UA, cookie, 'accept-language': 'zh-CN,zh;q=0.9' },
      referer: REFERER,
      timeout: 20000,
    })
  } catch (e) {
    throw withPrefix('抖音房间页获取失败', e)
  }
  const key = '\\"state\\":'
  const at = html.indexOf(key)
  if (at < 0) throw new Error('抖音房间页获取失败：页面未包含房间数据（直播间可能不存在）')
  const objStart = html.indexOf('{', at + key.length)
  return parseEscapedJson(sliceBalanced(html, objStart, '{', '}'), '抖音房间页获取失败：房间数据')
}

export async function room(http, { roomId } = {}) {
  const rid = String(roomId ?? '').trim()
  if (!/^\d{5,20}$/.test(rid)) throw new Error('抖音房间号无效')

  const webRid = rid.length <= 16 ? rid : await webRidByRoomId(http, rid)

  const state = await roomState(http, webRid)
  const info = state?.roomStore?.roomInfo ?? {}
  const r = info.room ?? {}
  const anchor = info.anchor ?? {}
  const live = Number(r.status) === 2

  const detail = {
    platform: id,
    roomId: webRid,
    title: String(r.title || anchor.nickname || `抖音 ${webRid}`),
    cover: absUrl(r.cover?.url_list?.[0] || anchor.cover?.url_list?.[0]),
    anchor: String(r.owner?.nickname || anchor.nickname || ''),
    online: live ? toNum(r.room_view_stats?.display_value ?? r.room_view_stats?.display_short) : 0,
    live,
  }

  if (!live) return { ...detail, qualities: [] }

  const qualities = qualitiesFrom(r.stream_url)
  if (!qualities.length) throw new Error('抖音播放地址获取失败：房间未下发可用的拉流地址')
  return { ...detail, qualities }
}
