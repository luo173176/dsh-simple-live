/**
 * 哔哩哔哩直播适配器。参考 dart_simple_live/simple_live_core/lib/src/bilibili_site.dart，
 * 但当前 B 站的 WBI 签名接口（getInfoByRoom / second/getList）一律返回 -352，
 * 因此改用无需签名的 room/v1 系列接口；搜索需要 buvid3/buvid4 指纹 cookie。
 *
 * @module dsh-simple-live/lib/live/sites/bilibili
 */

export const id = 'bilibili'
export const name = '哔哩哔哩'
export const accent = '#00aeec'
export const playHeaders = {
  referer: 'https://live.bilibili.com/',
  origin: 'https://live.bilibili.com',
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const REFERER = 'https://live.bilibili.com/'
const API_LIVE = 'https://api.live.bilibili.com'
const API = 'https://api.bilibili.com'

/* -------------------------------------------------------------- 会话指纹 --- */

let fingerprint = { cookie: '', at: 0 }

async function cookie(http) {
  if (fingerprint.cookie && Date.now() - fingerprint.at < 6 * 3600e3) return fingerprint.cookie
  try {
    const res = await http.json(`${API}/x/frontend/finger/spi`, {
      headers: { 'user-agent': UA, referer: REFERER },
      timeout: 8000,
    })
    const b3 = res?.data?.b_3 ?? ''
    const b4 = res?.data?.b_4 ?? ''
    fingerprint = { cookie: b3 ? `buvid3=${b3}; buvid4=${b4};` : '', at: Date.now() }
  } catch {
    fingerprint = { cookie: '', at: Date.now() }
  }
  return fingerprint.cookie
}

async function headers(http, referer = REFERER) {
  return {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer,
    origin: referer.replace(/\/$/, ''),
    cookie: await cookie(http),
  }
}

/* ---------------------------------------------------------------- 工具 --- */

function img(url, suffix = '') {
  let u = String(url ?? '')
  if (!u) return ''
  if (u.startsWith('//')) u = `https:${u}`
  else if (u.startsWith('/')) u = `https://i0.hdslb.com${u}`
  return suffix ? `${u}${suffix}` : u
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '')

function liveRoom(item) {
  return {
    platform: id,
    roomId: String(item.roomid ?? item.room_id ?? ''),
    title: stripTags(item.title),
    cover: img(item.cover ?? item.user_cover ?? item.keyframe ?? item.pic),
    anchor: stripTags(item.uname ?? ''),
    areaName: String(item.area_name ?? ''),
    online: Number(item.online ?? 0) || 0,
    live: item.live_status === undefined ? true : Number(item.live_status) === 1,
  }
}

/* ---------------------------------------------------------------- 分区 --- */

export async function categories(http) {
  const res = await http.json(`${API_LIVE}/room/v1/Area/getList?need_entrance=1&parent_id=0`, {
    headers: await headers(http),
    timeout: 10000,
  })
  const data = res?.data
  if (!Array.isArray(data)) throw new Error(`B站分区接口异常：${res?.message ?? res?.code ?? '无数据'}`)
  return data
    .filter((p) => Array.isArray(p.list) && p.list.length)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      children: p.list.map((c) => ({ id: String(c.id), name: String(c.name) })),
    }))
}

/* ------------------------------------------------------------ 房间列表 --- */

export async function rooms(http, { area = '0:0', page = 1 }) {
  const [parent, sub] = String(area).split(':')
  const qs = new URLSearchParams({
    platform: 'web',
    parent_area_id: parent || '0',
    area_id: sub || '0',
    sort_type: page === 1 ? 'online' : '',
    page: String(page),
    page_size: '30',
  })
  const res = await http.json(`${API_LIVE}/room/v1/Area/getRoomList?${qs}`, {
    headers: await headers(http),
    timeout: 12000,
  })
  if (res?.code !== 0) throw new Error(`B站房间列表获取失败：${res?.message ?? res?.code ?? '未知错误'}`)
  const list = Array.isArray(res.data) ? res.data : []
  return { items: list.map(liveRoom).filter((r) => r.roomId), hasMore: list.length >= 30 }
}

/* ---------------------------------------------------------------- 搜索 --- */

export async function search(http, { keyword, page = 1 }) {
  const q = String(keyword ?? '').trim()
  if (!q) return { items: [], hasMore: false }
  const qs = new URLSearchParams({ search_type: 'live', keyword: q, page: String(page), page_size: '20' })
  const res = await http.json(`${API}/x/web-interface/search/type?${qs}`, {
    headers: await headers(http, 'https://search.bilibili.com/live'),
    timeout: 12000,
  })
  if (res?.code !== 0) throw new Error(`B站搜索失败：${res?.message ?? res?.code ?? '未知错误'}`)
  const list = res?.data?.result?.live_room ?? []
  const items = list
    .map((it) => ({
      platform: id,
      roomId: String(it.roomid ?? ''),
      title: stripTags(it.title),
      cover: img(it.cover ?? it.user_cover ?? it.pic),
      anchor: stripTags(it.uname),
      areaName: stripTags(it.cate_name ?? it.area_name ?? ''),
      online: Number(it.online ?? 0) || 0,
      live: Number(it.live_status ?? 1) === 1,
    }))
    .filter((r) => r.roomId)
  return { items, hasMore: items.length >= 20 }
}

/* ------------------------------------------------------------ 房间详情 --- */

async function roomInfo(http, roomId) {
  const res = await http.json(`${API_LIVE}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`, {
    headers: await headers(http),
    timeout: 12000,
  })
  if (res?.code !== 0 || !res?.data?.room_id) {
    throw new Error(`B站房间信息获取失败：${res?.message ?? res?.code ?? '房间不存在'}`)
  }
  return res.data
}

async function anchorName(http, uid) {
  if (!uid) return ''
  try {
    const res = await http.json(`${API_LIVE}/live_user/v1/Master/info?uid=${encodeURIComponent(uid)}`, {
      headers: await headers(http),
      timeout: 8000,
    })
    return String(res?.data?.info?.uname ?? '')
  } catch {
    return ''
  }
}

/** 一次 getRoomPlayInfo，返回 { names:Map<qn,name>, groups:[{protocol,urls}] } */
async function playInfo(http, roomId, qn) {
  const qs = new URLSearchParams({
    room_id: String(roomId),
    protocol: '0,1',
    format: '0,1,2',
    codec: '0',
    platform: 'web',
    qn: String(qn),
  })
  const res = await http.json(`${API_LIVE}/xlive/web-room/v2/index/getRoomPlayInfo?${qs}`, {
    headers: await headers(http),
    timeout: 12000,
  })
  const play = res?.data?.playurl_info?.playurl
  if (!play) return { names: new Map(), groups: [] }
  const names = new Map((play.g_qn_desc ?? []).map((g) => [Number(g.qn), String(g.desc)]))
  const groups = []
  for (const stream of play.stream ?? []) {
    for (const fmt of stream.format ?? []) {
      for (const codec of fmt.codec ?? []) {
        const urls = (codec.url_info ?? []).map((u) => `${u.host}${codec.base_url}${u.extra}`)
        if (urls.length) {
          groups.push({
            protocol: String(stream.protocol_name ?? ''),
            format: String(fmt.format_name ?? ''),
            qn: Number(codec.current_qn ?? qn),
            urls: urls.sort((a, b) => Number(a.includes('mcdn')) - Number(b.includes('mcdn'))),
          })
        }
      }
    }
  }
  return { names, groups }
}

const WANTED_QN = [10000, 400, 250, 150]

export async function room(http, { roomId }) {
  const info = await roomInfo(http, roomId)
  const realId = String(info.room_id)
  const live = Number(info.live_status) === 1
  const base = {
    platform: id,
    roomId: realId,
    title: String(info.title ?? ''),
    cover: img(info.keyframe || info.user_cover),
    anchor: await anchorName(http, info.uid),
    areaName: String(info.area_name ?? ''),
    online: Number(info.online ?? 0) || 0,
    live,
  }
  if (!live) return { ...base, qualities: [] }

  const probes = await Promise.all(
    WANTED_QN.map((qn) => playInfo(http, realId, qn).catch(() => null)),
  )
  const qualities = []
  const seenUrl = new Set()
  const seenQn = new Set()
  for (const probe of probes) {
    if (!probe) continue
    const hls = probe.groups.filter((g) => g.protocol === 'http_hls')
    const flv = probe.groups.filter((g) => g.protocol === 'http_stream')
    const pick = (hls.length ? hls : flv)[0]
    if (!pick) continue
    if (seenUrl.has(pick.urls[0]) || seenQn.has(pick.qn)) continue
    seenUrl.add(pick.urls[0])
    seenQn.add(pick.qn)
    qualities.push({
      name: probe.names.get(pick.qn) ?? `清晰度${pick.qn}`,
      url: pick.urls[0],
      format: pick.protocol === 'http_hls' ? 'hls' : 'flv',
    })
  }
  return { ...base, qualities }
}
