# iLink 协议要点（实现笔记）

本项目的微信通道走**腾讯官方 iLink Bot API**（微信 ClawBot / 龙虾）。不需要公网 IP：本机进程**主动向外**长轮询。

## 验证过的事实

| 验证项 | 结果 |
|---|---|
| 服务端是否只认 OpenClaw | 不认，后端不检查客户端身份 |
| 扫码登录 | 成功签发 `ilink_bot_id`（形如 `xxx@im.bot`） |
| Bearer 认证 | 通过 |
| 长轮询收消息 | 收到真实消息，字段完整 |
| 发送文本 | 手机微信收到 |
| 无 `context_token` 的主动消息 | 服务端接受（会话窗口开着时） |
| 跨进程复用 token | 通过（重启无需重新扫码） |

## 架构

```text
手机微信 ──► 腾讯 iLink 服务 ──► 你在跑的电脑
                                  │
                            mimo-desktop-wechat
                                  │
                    ┌─────────────┴─────────────┐
                    │  src/core/                │  协议层，零 MiMo 依赖
                    │  登录 / 长轮询 / 发送 / 状态 │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │  src/plugin/              │  宿主粘合层
                    │  会话路由 / 工具 / 回复回流  │
                    └───────────────────────────┘
```

## 几条容易踩的坑

1. **`media.aes_key` = base64(hex 文本)**，不是 base64(原始 16 字节)。发错形态时服务照收、手机显示灰框。
2. **媒体引用取上传响应的 `x-encrypted-param` 头**；`upload_full_url` 里的长参数是上传授权，拿去读会 403。
3. **条目不要多发字段**：官方图片条目只有 `media` + `mid_size`，文件条目只有 `media` + `file_name` + `len`。
4. **`errcode` 与 `ret` 都要查**：发送被拒时服务回 HTTP 200 + `errcode`，只看 `message_id` 会把失败当成成功。
5. **`errcode = -14`** 表示会话超时：主动消息被拒，要等用户先发一条消息打开窗口。本项目把这类消息**排队**，下次入站时补发。
6. **uint64 精度**：`message_id` 等标识超过 `Number.MAX_SAFE_INTEGER`，必须按字符串解析（见 `src/core/http.ts` 的 `parseWireJson`）。

## 协议参考

以腾讯官方实现为准：

| 内容 | 来源 |
|---|---|
| 类型定义 | [`@tencent-weixin/openclaw-weixin` `src/api/types.ts`](https://unpkg.com/@tencent-weixin/openclaw-weixin@2.4.6/src/api/types.ts) |
| 出站条目构造 | 同包 `src/messaging/send.ts` |
| 出站上传流程 | 同包 `src/cdn/upload.ts` |
| 入站下载与解密 | 同包 `src/media/media-download.ts` |
| CDN URL 构造 | 同包 `src/cdn/cdn-url.ts` |

## 状态文件

默认 `~/.mimo-desktop-wechat/wechat/state.json`（0600，原子写）：

- `accounts` — bot token、baseUrl、绑定的微信用户
- `syncBufs` — 长轮询增量游标，进程重启不丢消息
- `contextTokens` — **按会话**存的回复令牌，多对话下不串台
- `bindings` — 微信对话 ↔ MiMo session 映射
- `pendingNotifications` — 会话窗口关闭时排队的主动推送
- `settings` — 合并窗口、回复上限等

## MiMo 侧对接

| 路径 | 用途 |
|---|---|
| `mimo run -s <session> --format json` | 独立 CLI 桥：把微信消息变成 agent 提示词 |
| `@mimo-ai/plugin` `session.post` | 会话结束 → 主动推微信 |
| `@mimo-ai/plugin` `tool.send_to_wechat` | agent 主动发微信 |
| `@mimo-ai/plugin` `permission.ask` | 权限申请推到手机 |

协议层与 MiMo 解耦，可单独单测（见 `src/core/tests/`，若有）。
