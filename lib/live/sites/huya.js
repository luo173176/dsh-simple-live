/**
 * 虎牙 live adapter. See CONTRACT.md at the plugin root.
 *
 * Ported from xiaoyaocz/dart_simple_live `simple_live_core/lib/src/huya_site.dart`:
 * categories come from the `bussLive` config, lists from `cache.php`, search from
 * `search.cdn.huya.com`, and the room page (`m.huya.com/<id>`) carries the whole
 * `HNF_GLOBAL_INIT` blob with every CDN line and its `sFlvAntiCode` / `sHlsAntiCode`.
 *
 * Playback needs a freshly signed anti-code: the one embedded in the page is
 * already expired (HTTP 403), so `buildAnticode()` re-derives `wsSecret` the way
 * ykdl / real-url do — `md5(secretPrefix_uid_stream_md5(seqid|ctype|t)_wsTime)`.
 *
 * @module dsh-simple-live/lib/live/sites/huya
 */

import { createHash } from 'node:crypto'

export const id = 'huya'
export const name = '虎牙'
export const accent = '#f0932b'
/** m.huya.com serves the room page only to a mobile client. */
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36 Edg/117.0.0.0'

// The primary HLS line (AL) only signs a playlist for a mobile client; with a
// desktop UA it answers 403. Playback goes through the plugin proxy, which sends
// exactly these headers, so the UA has to travel with them.
export const playHeaders = {
  referer: 'https://www.huya.com/',
  origin: 'https://www.huya.com',
  'user-agent': MOBILE_UA,
}

const TOP_CATEGORIES = [
  { id: '1', name: '网游' },
  { id: '2', name: '单机' },
  { id: '8', name: '娱乐' },
  { id: '3', name: '手游' },
]

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex')

/** Absolute http(s) URL, preferring https so the panel never hits mixed content. */
function absolute(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:/i, 'https:')
  return `https://${raw}`
}

/** GET and return `{ status, body }` without trusting the status code. */
async function fetchText(http, url, opts = {}) {
  const res = await http.request(url, { referer: 'https://www.huya.com/', ...opts })
  return { status: res.status, body: await res.text() }
}

async function fetchJson(http, url, opts = {}) {
  const { status, body } = await fetchText(http, url, opts)
  if (status !== 200) throw new Error(`虎牙接口返回 HTTP ${status}：${body.slice(0, 80)}`)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`虎牙接口返回了非 JSON 内容：${body.slice(0, 80)}`)
  }
}

/* ------------------------------------------------------------------ categories */

/** `gid` is either a number or `{ value: "1,2" }` depending on the game. */
function pickGid(gid) {
  if (gid && typeof gid === 'object') return String(gid.value ?? '').split(',')[0].trim()
  return String(gid ?? '').trim()
}

async function subCategories(http, bussType) {
  const data = await fetchJson(
    http,
    `https://live.cdn.huya.com/liveconfig/game/bussLive?bussType=${encodeURIComponent(bussType)}`,
    { timeout: 10000 },
  )
  const list = Array.isArray(data?.data) ? data.data : []
  return list
    .filter((item) => item && item.gameFullName)
    .map((item) => ({
      id: pickGid(item.gid) || String(item.gameHostName ?? ''),
      name: String(item.gameFullName).trim(),
    }))
    .filter((item) => item.id)
}

export async function categories(http) {
  const settled = await Promise.allSettled(
    TOP_CATEGORIES.map((group) => subCategories(http, group.id)),
  )
  const ok = settled.filter((item) => item.status === 'fulfilled')
  if (!ok.length) {
    const reason = settled.find((item) => item.status === 'rejected')?.reason
    throw new Error(`虎牙分类获取失败：${reason?.message ?? '接口无响应'}`)
  }
  return TOP_CATEGORIES.map((group, index) => {
    const result = settled[index]
    return {
      id: group.id,
      name: group.name,
      children: result.status === 'fulfilled' ? result.value : [],
    }
  })
}

/* ------------------------------------------------------------------ room lists */

function toRoom(item, fallbackArea) {
  const title = String(item.introduction ?? '').trim() || String(item.roomName ?? '').trim()
  return {
    platform: id,
    roomId: String(item.profileRoom ?? ''),
    title: title || '无标题',
    cover: absolute(item.screenshot),
    anchor: String(item.nick ?? '').trim(),
    areaName: item.gameFullName ? String(item.gameFullName) : fallbackArea,
    online: Number.parseInt(String(item.totalCount ?? ''), 10) || 0,
    live: item.isLive !== undefined ? item.isLive === true || item.isLive === 1 : true,
  }
}

export async function rooms(http, { area, page = 1 } = {}) {
  const current = Math.max(1, Number.parseInt(String(page ?? 1), 10) || 1)
  const params = new URLSearchParams({
    m: 'LiveList',
    do: 'getLiveListByPage',
    tagAll: '0',
    page: String(current),
    // cache-buster: page 1 is served from CDN cache without it
    tt: String(Date.now()),
  })
  // 面板传来的是 `parent:sub`，虎牙列表接口只认二级分区（子)id，直接用会把 "1:1" 当 gameId → 退回全站列表
  if (area !== undefined && area !== null && area !== '') {
    const gameId = String(area).includes(':') ? String(area).split(':').pop() : String(area)
    if (gameId && gameId !== '0') params.set('gameId', gameId)
  }

  const data = await fetchJson(http, `https://www.huya.com/cache.php?${params}`, { timeout: 12000 })
  if (data?.status !== 200 || !data?.data) {
    throw new Error(`虎牙房间列表获取失败：${String(data?.message ?? '返回结构异常')}`)
  }
  const items = Array.isArray(data.data.datas) ? data.data.datas : []
  const totalPage = Number.parseInt(String(data.data.totalPage ?? 0), 10) || 0
  return {
    items: items.map((item) => toRoom(item)).filter((room) => room.roomId),
    hasMore: current < totalPage,
  }
}

/* --------------------------------------------------------------------- search */

export async function search(http, { keyword, page = 1 } = {}) {
  const q = String(keyword ?? '').trim()
  if (!q) throw new Error('请输入搜索关键词')
  const current = Math.max(1, Number.parseInt(String(page ?? 1), 10) || 1)
  const rows = 20
  const params = new URLSearchParams({
    m: 'Search',
    do: 'getSearchContent',
    q,
    uid: '0',
    v: '4',
    typ: '-5',
    livestate: '0',
    rows: String(rows),
    start: String((current - 1) * rows),
  })

  const data = await fetchJson(http, `https://search.cdn.huya.com/?${params}`, { timeout: 12000 })
  const block = data?.response?.['3']
  if (!block) throw new Error(`虎牙搜索无结果字段：${JSON.stringify(data).slice(0, 80)}`)
  const docs = Array.isArray(block.docs) ? block.docs : []
  const items = docs
    .map((doc) =>
      toRoom(
        {
          profileRoom: doc.room_id,
          introduction: doc.game_introduction,
          roomName: doc.game_roomName,
          nick: doc.game_nick,
          screenshot: doc.game_screenshot,
          totalCount: doc.game_total_count,
          gameFullName: doc.gameName,
          isLive: doc.gameLiveOn,
        },
        doc.gameName,
      ),
    )
    .filter((room) => room.roomId)
  const found = Number.parseInt(String(block.numFound ?? 0), 10) || 0
  return { items, hasMore: found > current * rows }
}

/* ------------------------------------------------------------------ anti-code */

/**
 * Re-sign a page anti-code. `tars_mobile` (t=103) is the mobile HLS flavour and
 * is the one huya still accepts without a tars CDN-token round trip.
 */
function buildAnticode(anticode, uid, stream) {
  const raw = String(anticode ?? '')
  const query = new URLSearchParams(raw)
  const fmRaw = query.get('fm')
  if (!fmRaw) return raw

  const ctype = 'tars_mobile'
  const t = '103'
  const wsTime = Math.floor(Date.now() / 1000 + 21600).toString(16)
  const seqId = String(Date.now() + Number(uid))
  const fm = decodeURIComponent(fmRaw)
  const secretPrefix = Buffer.from(fm, 'base64').toString('utf8').split('_')[0]
  const secretHash = md5(`${seqId}|${ctype}|${t}`)
  const wsSecret = md5(`${secretPrefix}_${uid}_${stream}_${secretHash}_${wsTime}`)

  const out = new URLSearchParams({
    wsSecret,
    wsTime,
    seqid: seqId,
    ctype,
    ver: '1',
    fs: query.get('fs') ?? 'bgct',
    fm: fmRaw,
    dMod: 'mseh-0',
    sdkPcdn: '1_1',
    uid: String(uid),
    uuid: String(Math.floor(Math.random() * 4294967295)),
    t,
    sv: '202411221719',
    sdk_sid: String(Date.now()),
    a_block: '0',
  })
  return out.toString()
}

/* ----------------------------------------------------------------- room detail */

function parseInit(html) {
  const marker = 'window.HNF_GLOBAL_INIT'
  const at = html.indexOf(marker)
  if (at < 0) throw new Error('虎牙房间页结构异常：未找到房间数据')
  const start = html.indexOf('{', at)
  const end = html.indexOf('</script>', start)
  const raw = html.slice(start, end < 0 ? undefined : end).trim()
  try {
    return JSON.parse(raw)
  } catch {
    // older pages inline `function(){}` values inside the blob
    const stripped = raw.replace(/function[\s\S]*?\{[\s\S]*?\}/g, '""')
    try {
      return JSON.parse(stripped)
    } catch {
      throw new Error('虎牙房间数据解析失败（页面结构可能已调整）')
    }
  }
}

/** `<scheme>://host/<stream>.m3u8` for one CDN line, keeping the line's own scheme. */
function hlsUrl(line, stream, scheme) {
  const host = String(line.sHlsUrl ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
  return `${scheme}://${host}/${stream}.m3u8`
}

/**
 * Pick the first CDN line whose HLS playlist really plays, preferring https.
 *
 * Only a *media* playlist (`#EXTINF`) is accepted: the TX line answers with a
 * master playlist whose child edge 403s even with a fresh anti-code, and the HS
 * line rejects some ratios. Each line is probed with the same headers the proxy
 * uses for playback, so a line that passes here also plays.
 */
async function pickHlsLine(http, lines, stream, uid) {
  for (const scheme of ['https', 'http']) {
    for (const line of lines) {
      if (!line.sHlsUrl) continue
      const url = `${hlsUrl(line, stream, scheme)}?${buildAnticode(line.sHlsAntiCode, uid, stream)}`
      try {
        const { status, body } = await fetchText(http, url, {
          timeout: 8000,
          headers: { 'user-agent': MOBILE_UA },
        })
        if (status === 200 && body.includes('#EXTINF')) return { line, scheme }
      } catch {
        /* try the next line / scheme */
      }
    }
  }
  return null
}

function bitRateList(streamInfo) {
  const source = streamInfo?.vBitRateInfo?.value
  const list = (Array.isArray(source) ? source : [])
    .filter((item) => item && item.sDisplayName && !String(item.sDisplayName).includes('HDR'))
    .map((item) => ({
      name: String(item.sDisplayName).trim(),
      bitRate: Number.parseInt(String(item.iBitRate ?? 0), 10) || 0,
    }))
  if (list.length) return list
  return [
    { name: '原画', bitRate: 0 },
    { name: '高清', bitRate: 2000 },
  ]
}

export async function room(http, { roomId } = {}) {
  const rid = String(roomId ?? '').trim()
  if (!rid) throw new Error('缺少虎牙房间号')

  const { status, body } = await fetchText(http, `https://m.huya.com/${encodeURIComponent(rid)}`, {
    headers: { 'user-agent': MOBILE_UA },
    timeout: 12000,
  })
  if (status !== 200 || !body.includes('HNF_GLOBAL_INIT')) {
    throw new Error(`虎牙房间 ${rid} 打开失败（HTTP ${status}）`)
  }

  const init = parseInit(body)
  const roomInfo = init.roomInfo ?? {}
  const liveInfo = roomInfo.tLiveInfo ?? {}
  const profile = roomInfo.tProfileInfo ?? {}
  const streamInfo = liveInfo.tLiveStreamInfo ?? {}
  const isLive = roomInfo.eLiveStatus === 2

  const lines = (Array.isArray(streamInfo.vStreamInfo?.value) ? streamInfo.vStreamInfo.value : [])
    .filter((line) => line && line.sStreamName && (line.sHlsUrl || line.sFlvUrl))
  const stream = lines[0]?.sStreamName ?? ''
  const uid = String(lines[0]?.lPresenterUid ?? liveInfo.lChannelId ?? init.roomProfile?.lUid ?? '')

  const detail = {
    platform: id,
    roomId: String(liveInfo.lProfileRoom ?? rid),
    title: String(liveInfo.sIntroduction ?? '').trim() || String(liveInfo.sRoomName ?? '').trim() || '无标题',
    cover: absolute(liveInfo.sScreenshot),
    anchor: String(profile.sNick ?? '').trim(),
    areaName: String(liveInfo.sGameFullName ?? '').trim() || undefined,
    online: Number.parseInt(String(liveInfo.lTotalCount ?? 0), 10) || 0,
    live: isLive,
    qualities: [],
  }

  if (!isLive || !lines.length || !stream) return detail

  const hlsLine = await pickHlsLine(http, lines, stream, uid)
  const bitRates = bitRateList(streamInfo)

  if (hlsLine) {
    const base = hlsUrl(hlsLine.line, stream, hlsLine.scheme)
    detail.qualities = bitRates.map((item) => {
      const anticode = buildAnticode(hlsLine.line.sHlsAntiCode, uid, stream)
      const url = item.bitRate > 0 ? `${base}?${anticode}&ratio=${item.bitRate}` : `${base}?${anticode}`
      return { name: item.name, url, format: 'hls' }
    })
    return detail
  }

  // No HLS line answered: fall back to progressive FLV (hls.js cannot use it).
  const flvLine = lines.find((line) => line.sFlvUrl)
  if (flvLine) {
    const base = `${absolute(flvLine.sFlvUrl)}/${stream}.flv`
    detail.qualities = bitRates.map((item) => {
      const anticode = buildAnticode(flvLine.sFlvAntiCode, uid, stream)
      const extra = item.bitRate > 0 ? `&ratio=${item.bitRate}` : ''
      return { name: item.name, url: `${base}?${anticode}${extra}&codec=264`, format: 'flv' }
    })
  }
  return detail
}
