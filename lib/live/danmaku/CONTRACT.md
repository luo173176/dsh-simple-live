# 弹幕适配器契约（dsh-simple-live）

零新增依赖：只能用 Node 22 内置能力（`node:net`、`node:tls`、`node:zlib`、`node:crypto`、
全局 `WebSocket` / `fetch`）。**禁止 import 任何第三方包**。

## 入口

`lib/live/danmaku/index.js` 必须导出：

```js
export async function open(platform, roomId, opts) -> Session
```

- `platform`: `'bilibili' | 'douyu' | 'huya' | 'douyin'`
- `roomId`: 字符串，房间详情里的 `roomId`（B 站为真实房间号 `room_id`）
- `opts`:
  - `onEvent(ev)`: 回调，**可能被高频调用**，实现内部必须包 try/catch，绝不能让回调异常中断连接
  - `cookie?: string`：该平台的登录 cookie（可为空串/undefined）
  - `signal?: AbortSignal`：外部取消
- 返回 `Session = { close(): void }`，`close()` 必须**幂等**，清理 socket、定时器、重连。

## 事件形状

```js
{ type: 'status', state: 'connecting'|'open'|'closed'|'unsupported'|'error', message?: string }
{ type: 'chat', user: string, text: string, color?: string, ts: number }   // ts = Date.now()
{ type: 'gift', user: string, text: string, ts: number }                   // 可并入 chat 也可以单列
```

- 连接开始先发 `{type:'status',state:'connecting'}`，握手成功发 `{type:'status',state:'open'}`。
- 该平台无法在零依赖下取弹幕时，**必须**先发
  `{type:'status',state:'unsupported',message:'<中文说明>'}` 再发 `closed`，不得抛异常。
- 心跳/超时导致的断线要**自动重连**（指数退避 1s→2s→4s→8s，最多 5 次）；重连成功再发一次 `open`。
- 最终关闭（用户 close、重连耗尽）发 `{type:'status',state:'closed'}`。

## 已知协议参考（自行核实，不要照抄错误细节）

- **bilibili**：`wss://broadcastlv.chat.bilibili.com/sub`（备用 `wss://tx-bj-live-comet-02.chat.bilibili.com/sub`）。
  16 字节头：`[4]packetLen(be) [2]headerLen=16(be) [2]protoVer [4]op(be) [4]seq(be)`；
  op=7 认证 `{"uid":0,"roomid":<realRoomId>,"protover":3,"platform":"web","type":2}`（有 cookie 可带 `buvid`/`key`）；
  op=2 心跳（每 30s，body 可空）；protoVer=3 表示 body 用 **brotli** 压缩、2 表示 zlib；
  收到 op=5 的 body 可能是多包拼接，需要按 4 字节长度递归拆包；控制台消息 `cmd:'DANMU_MSG'`，文本在 `info[1]`，用户名 `info[2][1]`，颜色 `info[3]` 是十进制整数（转 #rrggbb）。
- **douyu**：TCP `openbarrage.douyucdn.cn:8601`（8602 备用）。纯文本 `@A` 分隔、`key@=value/` 结尾。
  登录：`type@=loginreq/roomid@=<rid>/`，随后 `type@=joingroup/rid@=<rid>/gid@=-9999/`，
  心跳 `type@=keeplive/tick@=<秒级时间戳>/` 每 45s（超过约 60s 无心跳会被踢）。
  弹幕：`type@=chatmsg`，字段 `nn@=（昵称） txt@=（内容） col@=（颜色，0 为默认）`。
  注意：真实弹幕需要 `roomid` 的**真实房间号**（斗鱼 rid 与 URL 一致）。
- **huya / douyin**：零依赖下协议过重（TARS+base64 / protobuf），允许降级为 `unsupported`，
  但要在 message 里写清楚原因（例如“虎牙弹幕需要 TARS 编码，当前零依赖实现暂不支持”）。

## 自测要求（必须真连）

在 `scratch/danmaku-probe.mjs` 里写一个真连脚本，接受参数 `platform roomId [秒数]`，
打印收到的前 5 条 chat 与全部 status 事件后退出。至少用真实**在播**房间跑通 bilibili，
并如实记录 douyu 结果（能通就通，不通就说明原因，不许伪造数据）。
参考在播房间（会变，先自己查一个在播的）：bilibili 545068 / douyu 71415。
