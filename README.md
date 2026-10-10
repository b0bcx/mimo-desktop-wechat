# mimo-desktop-wechat

**手机微信遥控本机 MiMo Desktop / MiMoCode** —— 锁屏出门也能用，还会主动联系你。

把「微信当遥控器」的体验接到 **MiMo Desktop / MiMoCode** 上：

```text
手机微信 ──► 腾讯 iLink 服务 ──► 你这台电脑
                                  │
                          mimo-desktop-wechat
                                  │
                    ┌─────────────┴─────────────┐
                    │  src/core/                │  iLink 协议层
                    │  登录 / 长轮询 / 发送 / 状态 │
                    └─────────────┬─────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │  src/plugin/              │  MiMo 粘合层
                    │  会话路由 / 工具 / 主动推送  │
                    │  mimo run 或 @mimo-ai/plugin
                    └───────────────────────────┘
```

- **不需要公网 IP、不需要内网穿透**：本机进程主动向外长轮询腾讯服务器。
- **不需要 OpenClaw**：协议走腾讯官方 iLink Bot API（微信 ClawBot / 龙虾通道）。
- **扫码即绑**：机器人与你的微信账号密码学绑定，别人加不到、发不进。

---

## 功能

| 能力 | 说明 |
|---|---|
| **文字双向** | 微信消息变成 MiMo 提示词，回复发回微信 |
| **锁屏可用** | 电脑锁屏、人出门，手机照样下任务、收结果 |
| **一个微信，一个会话** | 微信固定对应唯一会话「MiMo微信」；`/list` `/switch` 也能切去桌面端其它会话 |
| **回复数字即切换** | `/list` 后直接回 `3` 就切过去；大白话（「换个对话」「切换到3」「查看模型」）同样有效 |
| **主动联系你** | 会话结束、任务做完，自动推送到你微信；也可用 `notify` / `send_to_wechat` |
| **跨会话推送** | 干活的那个会话不是微信绑定的那个，也能把结果推到你手机 |
| **两种接法** | ① 独立 CLI（开箱即用）② MiMo 插件（`@mimo-ai/plugin`，带 `send_to_wechat` 工具） |

---

## 快速开始

### 0. 一键启动（推荐）

双击工程目录里的 **`一键启动.bat`**：自动找 Node →（首次）构建 → 检查微信绑定 → 启动桥。  
关掉窗口即停止。

### 1. 前置

- Node.js ≥ 22.13
- 本机已安装 `mimo`（`npm i -g @mimo-ai/cli`），或 MiMo Desktop 正在运行
- 一台保持开机的电脑

### 2. 安装

```bash
cd mimo-desktop-wechat
npm install
npm run build
```

### 3. 扫码绑定微信

```bash
node dist/cli/index.js login
# 或者 npm link 之后：
mimo-desktop-wechat login
```

终端会出现二维码，用**手机微信**扫码并确认。绑定信息存在 `~/.mimo-desktop-wechat/wechat/account.json`（权限 0600）。

### 4. 启动通道

```bash
node dist/cli/index.js run
```

或直接双击 **`一键启动.bat`**。

然后在微信里给机器人发 `你好`，应收到回复。发 `/help` 看指令表。

### 5. 主动推送

另开一个终端：

```bash
node dist/cli/index.js notify "构建完成了，测试全绿"
```

或者让 MiMo 会话用 `send_to_wechat` 工具（见下）。

---

## 微信里可用的指令

| 指令 | 作用 |
|---|---|
| `/mimowechat` | 回到唯一会话。**微信只有一个会话，固定叫「MiMo微信」**；想清空历史就在桌面端删除它，下次发消息自动重建 |
| `/list` | 列出全机最近对话（默认 10 条，**按最近对话排序**，含桌面端各项目） |
| `/list 10` | 只看最近 10 条（`N` 可换，上限 50；`/list10` 也行） |
| `/list all` | 兼容保留，等同 `/list` |
| `/switch 3` | 切到列表第 3 个（编号对应你刚看到的那份列表） |
| `/current` | 当前在哪个对话 |
| `/cancel` | 中断正在跑的任务 |
| `/model [名称]` | 查看或切换模型（**两条链路**，见下） |
| `/help` | 帮助 |

空格可省：`/switch3`、`/switch 3`、`/switch:3` 都行。大白话同样被路由到对应动作：**回复列表里的数字**即切换，「换个对话」「看下有哪些对话」出列表，「切换到3」「切换到<标题>」直接切，「查看模型」「有哪些模型」走 `/model`。其余问题照常交给 agent。

### 切换模型：同名不同路

MiMo Desktop 里自带的 **Smart / 2.6 Flash / 2.6 Pro**，和配置里**所有自定义供应商**（小米 Key 只是其中一个，你加的 a6api 等也会列出来）名可能相同、链路不同，微信里用前缀或完整 id 区分：

| 分组 | 微信发 | 实际 |
|---|---|---|
| **桌面端内置** | `/model d-smart` / `d-flash` / `d-pro` | `mimo-desktop/…`（SSO） |
| **自定义供应商**（每次 `/model` 现读配置） | `/model glm-5.3` 或 `/model a6api-com/glm-5.3` | `a6api-com/glm-5.3` |
| 同上 | `/model mimo-v2.6-pro` | `xiaomi/mimo-v2.6-pro` |
| 跟随配置 | `/model 默认` | （不传 `-m`） |

- 目录来源：`~/.config/mimocode/mimocode.jsonc` 的 `provider`（及项目 `.mimocode/mimocode.json*`），**改配置后直接 `/model` 即可看到，不必重启通道**
- **桌面链路**需要 MiMo Desktop 在运行：走桌面端的本地控制 API（`%APPDATA%\Xiaomi MiMo\desktop-api.json` 的端口+token，`POST /v1/sessions/<id>/turns` + SSE 收回复），不依赖引擎密码；桌面端没开时提示改用自定义供应商 id
- 选择持久化在 `~/.mimo-desktop-wechat/current-model.txt`

---

## 作为 MiMo Desktop 插件使用

```bash
mimo plugin mimo-desktop-wechat -g
# 或把 "mimo-desktop-wechat" 写进 ~/.config/mimocode/mimocode.jsonc 的 plugin 数组
```

重启 MiMo Desktop 后，插件会：

1. 在后台拉起微信长轮询
2. 注册 **`send_to_wechat`** 工具 —— agent 可主动把文字/文件推到你微信
3. 监听 **`session.post`** —— 会话一结束就推送摘要（「做完了」）
4. 监听 **`permission.ask`** —— 权限申请推到微信，不在电脑旁也不卡住

在会话里直接说：

> 任务做完了发微信告诉我

agent 就会调用 `send_to_wechat`。

---

## 状态与安全

```text
~/.mimo-desktop-wechat/
  wechat/account.json     # bot token（0600）
  wechat/state.json       # 游标、会话绑定、排队中的推送
  session-index.json      # 微信侧会话列表
  workspace/              # 微信创建的会话工作区
  notify/                 # CLI 留下的待发通知
```

- **只有你自己能碰到它**：通道只连腾讯官方 iLink 网关；扫码后 token 与你的微信账号绑定，服务端只投递这一个账号的消息。
- **agent 以你的身份运行**：能读写文件、执行命令。离开时请**锁屏**（锁屏不影响 agent 干活）。
- **默认权限较宽**（手机上否则每条命令都会卡在权限确认里）。若要恢复桌面同款把关，调低会话权限预设。

---

## 开发

```bash
npm run typecheck
npm run build
```

协议细节见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

### 目录

```text
src/
  core/           iLink 协议：登录、长轮询、发送、状态、会话路由
  plugin/         MiMo 粘合：bridge、gateway、account、插件入口
  cli/            login / run / notify / status
docs/             协议与实现笔记
examples/         最小回声机器人示例
```

### 调试

```bash
node dist/cli/index.js status
# 看 ~/.mimo-desktop-wechat/ 下的日志与 state.json
```

---

## License

MIT，详见 [LICENSE](LICENSE)（含第三方衍生声明）。
