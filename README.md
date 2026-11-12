# dsh-simple-live

DSH（DeepSeek Harness）聚合直播插件：把 **哔哩哔哩 / 斗鱼 / 虎牙 / 抖音 / 快手** 五个平台的直播聚合到一个左侧栏面板里，并给模型提供四个直播检索 / 播放工具。

Aggregated live-streaming panel for DeepSeek Harness — browse and play bilibili / douyu / huya / douyin / kuaishou live rooms from one sidebar panel, with model-facing tools.

![聚合直播](assets/screenshot-1.png)

## 功能 Features

- **五平台聚合**：顶部横向切换平台，分区 / 关注 / 搜索三种浏览方式。
- **分类浏览**：拉取各平台真实分区树，两级分类点选。
- **搜索**：按主播或房间标题搜索（抖音搜索需登录 cookie，纯数字按房间号直达）。
- **播放**：HLS 播放（内置 hls.js），多清晰度切换，线路自动探测。
- **弹幕**：哔哩哔哩 / 斗鱼 / 虎牙 / 抖音真实弹幕（WSS 协议），弹幕栏可收起；快手弹幕需登录且受平台限流影响，会给出明确提示。
- **我的**：
  - 解析链接：支持哔哩哔哩 / 斗鱼 / 虎牙 / 抖音 / 快手 的直播间链接，`b23.tv` / `v.douyin.com` / `v.kuaishou.com` 短链，分享文案，以及 `平台:房间号`。
  - 观看记录：本地保存最近观看（去重、上限 200）。
  - 账号登录：按平台保存 cookie（仅存本机）；保存后自动校验，显示昵称 / 头像 / UID 或「Cookie 失效」，提升清晰度与搜索成功率。
  - 播放设置：弹幕开关 / 透明度 / 字号 / 速度、自动播放、默认清晰度。
- **关注**：收藏主播，关注页实时刷新在播状态。
- **模型工具**：`live_categories` / `live_trending` / `live_search` / `live_play`，让模型直接查分区、找房间、把房间排进面板播放。

![播放器 · 多清晰度与实时弹幕](assets/screenshot-2.png)

## 支持解析的链接 Supported links

「我的 → 解析链接」支持以下输入：

| 平台 | 链接示例 | 短链 |
| --- | --- | --- |
| 哔哩哔哩 | `live.bilibili.com/545068` | `b23.tv/xxxx` |
| 斗鱼 | `www.douyu.com/71415`、`…/topic?rid=71415` | — |
| 虎牙 | `www.huya.com/333003` | — |
| 抖音 | `live.douyin.com/272509728241`、`webcast.amemv.com/webcast/reflow/<id>` | `v.douyin.com/xxxx` |
| 快手 | `live.kuaishou.com/u/<authorId>` | `v.kuaishou.com/xxxx` |
| 任意 | `平台:房间号`（如 `bilibili:545068`、`kuaishou:3xkhqwbegbm7kte`） | — |

也接受直接粘贴平台分享文案（会自动从中提取链接）。

## 安装 Install

从市场或命令行安装：

```sh
dsh plugin add github:luo173176/dsh-simple-live
```

安装后在左侧栏出现「聚合直播」入口。

## 模型工具 Tools

| 工具 | 作用 |
| --- | --- |
| `live_categories` | 列出某平台的直播分区（分组 / 子分区） |
| `live_trending` | 拉取某平台 / 分区的热门直播 |
| `live_search` | 按关键词搜索直播房间 |
| `live_play` | 在左侧栏面板里打开并播放指定房间 |

## 说明 Notes

- 数据与登录信息仅保存在本机 `~/.dsh/simple-live/`。
- 各平台接口可能随时调整；清晰度以平台实际返回为准。
- 快手弹幕需要快手登录 cookie，且匿名访问易被平台限流，未满足条件时播放器会明确提示。

![我的 · 解析链接](assets/screenshot-3.png)

## 参考与致谢 Credits

本插件是对现有开源项目的移植与再实现，接口逻辑、弹幕协议均参考下列成果，在此致谢：

- **[xiaoyaocz/dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live)** —— 原项目（Flutter/Dart）。本插件的平台聚合思路、各平台分区 / 列表 / 播放接口、以及 B 站 / 斗鱼 / 虎牙 / 抖音 / 快手弹幕协议，均参考其实现。
- **[xuanxuan123xuan/dart_simple_live](https://github.com/xuanxuan123xuan/dart_simple_live)** —— 上游的 fork，作为本次端口的主要参考基线。
- **[video-dev/hls.js](https://github.com/video-dev/hls.js)** —— 内置的 HLS 播放库（`vendor/hls.min.js`，Apache-2.0）。
- 各直播平台的公开 Web 接口。

本项目以 MIT 许可发布；上述第三方项目的版权与许可归其各自作者所有。

## 许可 License

MIT
