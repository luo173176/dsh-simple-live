# Adapter contract — `lib/live/sites/<site>.js`

One file per live platform. Pure ESM, no dependencies beyond Node 22 globals and
the shared `http` object handed in at call time. Nothing here may import the
rest of the plugin.

## Exports

```js
export const id = 'douyu'          // lowercase, matches the file name
export const name = '斗鱼'          // shown in the panel rail
export const accent = '#ff7a00'    // one brand colour, used for the rail dot
export const playHeaders = {       // injected by the playback proxy
  referer: 'https://www.douyu.com/',
  origin: 'https://www.douyu.com',
}

export async function categories(http)                  // () => Area[]
export async function rooms(http, { area, page })       // () => Page<Room>
export async function search(http, { keyword, page })   // () => Page<Room>
export async function room(http, { roomId })            // () => RoomDetail
```

All four are async and must throw an `Error` with a short human-readable
Chinese message on failure — the panel prints `error.message` verbatim.

## `http`

```ts
http.request(url, opts) => Promise<Response>
http.text(url, opts)    => Promise<string>
http.json(url, opts)    => Promise<any>
http.buffer(url, opts)  => Promise<{ status, headers, body: Buffer }>

opts = { method?, headers?, body?, referer?, timeout?, signal? }
```

`http` already sends a desktop Chrome User-Agent and `accept-language: zh-CN`.
Pass `referer` when a site checks it. Set `timeout` (ms) on slow endpoints.

## Types

```ts
interface Area {
  id: string        // opaque; handed back verbatim as `area`
  name: string
  children?: Area[] // level-2 categories; the panel renders them as chips
}

interface Room {
  platform: string       // = the module's `id`
  roomId: string         // the id the site's own URLs use
  title: string          // room title
  cover: string          // absolute http(s) cover URL
  anchor: string         // streamer name
  areaName?: string
  online?: number|string // viewers, if the API reports it
  live: boolean          // true when the room is streaming
}

interface Page<T> { items: T[]; hasMore: boolean }

interface Quality {
  name: string              // 原画 / 蓝光 / 高清 / 流畅
  url: string               // absolute URL of the media playlist or stream
  format: 'hls' | 'flv'     // 'hls' = .m3u8, 'flv' = progressive FLV
}

type RoomDetail = Room & { qualities: Quality[] }
```

Rules:

- `page` is 1-based; return `hasMore: false` on the last page.
- `qualities` must be ordered best → worst and contain at least one entry for a
  live room. An offline room returns `qualities: []` and `live: false`.
- Prefer an HLS (`m3u8`) rendition when the site offers one; FLV only as a
  fallback. The panel plays HLS with hls.js and FLV with mpegts-less `<video>`
  only when hls.js cannot be used, so a wrong `format` shows a black player.
- Never hard-code an absolute expiry token into a cached result: resolve
  qualities inside `room()` on every call.
- Do not add `?` query junk the CDN rejects; keep the URL exactly as the site
  handed it out.

## Verifying your adapter

Run from the plugin root (`E:\Users\luo17\Documents\DeepSeek\projects\dsh-simple-live`):

```powershell
node --input-type=module -e "import('./lib/live/http.js').then(async (m) => { const http = m.createHttp(); const s = await import('./lib/live/sites/douyu.js'); const a = await s.categories(http); console.log(JSON.stringify(a).slice(0,600)); const r = await s.rooms(http, { area: a[1].children?.[0]?.id ?? a[0].id, page: 1 }); console.log(JSON.stringify(r.items.slice(0,3))); const d = await s.room(http, { roomId: r.items[0].roomId }); console.log(JSON.stringify(d.qualities)); })"
```

Acceptance: the command prints real category names, ≥1 room with a real title
and cover, and ≥1 playable quality URL for a room that is currently live.
A room that is offline is not proof — pick one from the list whose `live` is true.
