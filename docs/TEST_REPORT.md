# Direct Plan Bridge 0.1.9 — 验证报告

日期：2026-10-07。交付：本地预览版 VSIX 与完整源码包。

用户已确认 GPT-6.1-Sol 与 GPT-6-Astra 在线推理均可用；Astra 在 0.1.9 历史编码修正后恢复。真实 VS Code 1.140.0 宿主与合成传输验证模型注册、目录快照、配置传递、历史转换及工具交接。

## 实现与功能依据

### Astra 输入历史拒绝的修正

实际日志显示 gpt-6-astra 三次返回 HTTP 400 / invalid_value，参数为 input[4].content[0]；未采样。适配器此前将未命中缓存的助手历史编码成逐项 input_text。本版改用官方 SDK EasyInputMessage 支持的字符串内容，保留可见文本与工具顺序，并在输入拒绝日志增加对应项角色与内容类型。用户在更新至 0.1.9 后重试，确认 Astra 恢复正常。

真实 VS Code 宿主已检查实际 Assistant 消息在空缓存时输出字符串内容；证据为 docs/ASSISTANT_HISTORY_VALIDATION.json。缓存命中时原始 output 重放保持通过，未发起真实账号推理。


### 内置快照补齐

normalizeCatalog 先建立实时 slug 集合，快照只补充集合中不存在的可见模型，然后沿用统一的归一化流程。实时同名模型的名称、思考强度、容量及 visibility 保持优先。日志区分 live/snapshot 来源与补充数量。

真实 VS Code 1.140.0 宿主使用不含 gpt-6.1-sol 的合成实时目录：快照补充后原生注册服务能够选择此模型，sendRequest 构造的 Responses 请求为 model=gpt-6.1-sol、reasoning.effort=high。证据见 docs/SNAPSHOT_VALIDATION.json。此验证未发起真实套餐推理，尚未确认服务端接受快照补充型号。


### 模型目录诊断

本版增加目录请求、HTTP 结果、每个返回条目的筛选原因、Provider 缓存状态与最终提交给宿主的型号日志。功能验证模拟服务端返回 Astra/Luna 可见、Sol 隐藏：实际适配结果为 Astra/Luna，日志仍完整记录三个条目与 Sol 的 visibility_not_list 原因，未记录凭据。筛选规则保持原有行为。真实目录日志已确认公共目录未返回 6.1-Sol、6-Sol 和 6-Luna；快照补齐后用户确认 6.1-Sol 推理可用。


### 提示词编辑与即时生效

真实 VS Code 宿主通过配置 API 写入自定义提示词，再发送原生模型请求，实际请求包含编辑后的 developer 文案与渲染后的主模型选择器。之后配置为空并发送下一次请求，input 不再包含扩展提示词；整个过程未重载扩展。结果见 `docs/PROMPT_VALIDATION.json`。原默认路由和思考强度验证同时通过。

### 原生思考强度与子 agent 提示词

实际 Provider 经原生模型注册服务被发现。未指定配置时收到 `provider-default`；调用原生 sendRequest 并选择 High 时，Provider 收到 `modelConfiguration.reasoningEffort=high`，构造的 Responses 请求包含 `reasoning.effort=high`。目录支持等级生成菜单，Model default 会省略 effort，Extension default 使用全局设置。

同一宿主请求提供 runSubagent 工具时，发送的 input 中包含新增 developer 指令，Sonnet 使用实际 `Host GPT Sol (l89669-chatgpt-direct)` 选择器，并明确要求填写 model。Haiku、Opus 分别映射 Luna、Astra；目录缺少系列时使用主模型。实际指令与配置输出见 `docs/SETTINGS_VALIDATION.json`。

这一验证使用真实 VS Code 注册和请求通路、合成模型目录与传输；未操作可见菜单，也未发起真实账号推理。提示词注入位置及请求参数已经验证，实际模型遵循提示词的效果不属于强制参数改写。


### 中间响应继续

已观察到宿主保存的实际提交审查回答只有“我会检查远端提交”的说明，没有工具调用。旧适配器收到 `response.completed` 就返回，未读取模型回合结束标记。

`consumeResponse` 现在保留 `response.end_turn`；`OpenAIClient.infer` 根据明确标记继续采样，缺省时使用 commentary/partial_answer phase 判断中间响应。后续请求原样追加已完成输出，保留推理状态；工具调用交回宿主执行。多次采样合并为一个宿主回答的重放记录。

已验证以下实际转换结果：

- “我会检查提交”且 end_turn=false → 第二次采样得到工具调用 → 返回给宿主。
- commentary 且未提供结束标记 → 第二次采样得到最终回答。
- 中间推理与两个消息 phase 在后续宿主请求中完整恢复。
- completion 元数据的 output 为空时，仍保留此前流式传入的消息和 phase。

`docs/CONTINUATION_VALIDATION.json` 包含合成模型响应的继续请求、状态决策、交付工具调用及后续重放结果。在真实 Extension Host 中使用实际 TextPart/ToolCallPart，验证 Provider 经两次采样后交付工具调用再结束 Promise；模型响应为本地合成数据，未消耗套餐额度。

### 响应格式

`inspectResponseFormat` 在 Content-Type 不同于 SSE 时检查正文起始协议，并将已读取字节原样交给解析器。真正的 SSE 正文仍必须到达 `response.completed`，工具调用仍在完成后验证并交回宿主。

新增验证覆盖：Content-Type 为 application/json、正文实际为 SSE 的单字节分块响应可完成；普通 JSON 响应报告 HTTP 状态、类型、结构而不记录正文；JSON 用量错误保留服务器机器码。

已在真实 VS Code 1.140.0 Extension Host 中，对 `/v1/models` 发起不含凭据的 HTTPS GET，得到 HTTP 401、Content-Type application/json 和请求 ID，确认该宿主的原生传输能读取响应头。此操作未发起推理。用户此前 non-SSE 失败的实际正文未被旧版保存，需要更新后请求的协议诊断确定原因。

### 原生系统消息

已核对本机 VS Code 1.140.0 的实际运行时代码及对应 commit `07f806f999227108933c2e30515b26eecc1fda74`：原生角色为 `User = 1`、`Assistant = 2`、`System = 3`。`roleName` 将 System 转为 Responses `developer`，保留系统指令内容。

在真实 Extension Host 中，通过实际 `vscode.LanguageModelChatMessage`、`LanguageModelTextPart`、`LanguageModelToolCallPart` 和 `LanguageModelToolResultPart` 构造消息并调用请求适配器，验证输出为 developer → user → function_call → function_call_output，内容与调用标识均保留。验证输出见 `docs/HOST_TEST_RESULTS.txt`。

### 完整响应重放

`src/protocol/history.js` 的 `ResponseReplayCache` 保存每次完成响应的原始 `output` 数组。`src/openai/client.js` 在收到 `response.completed` 并解析完工具调用后，将输入历史与完整输出交给该 owner；下一轮 `convertMessages` 根据前序对话和宿主可见输出匹配记录，并插入原始有序数组。

因此保留的是完整响应：助手消息的 `phase`、纯文本回合的加密 reasoning、工具调用之前和之后的 reasoning，以及原始工具调用项。宿主返回的工具结果继续单独编码为 `function_call_output`。消息流分块或相邻助手消息合并后仍可匹配同一记录。

验证已检查下一轮实际构造的 Responses `input`：

- 工具前说明恢复为 `phase: commentary`，工具调用后的 reasoning 继续保留，随后出现宿主提供的工具结果。
- 纯文本回答恢复为 `phase: final_answer`，继续追问时带回对应加密 reasoning。
- 合并显示的进度与最终回答恢复为两个具有各自 phase 的原始消息。
- 两轮相同的可见回答按各自前序对话恢复各自的推理项。
- 宿主修改答案或压缩前序对话后，使用其现有历史转换结果。

`docs/REPLAY_VALIDATION.json` 保存无账号、无联网的功能验证输出。该验证调用实际 SSE 消费、客户端缓存与请求适配代码，记录工具回合、纯文本回答之后的下一轮请求；内容均为合成示例。

缓存保留于当前扩展进程，payload 上限 16 MiB、TTL 1 小时；切换账户或 session 时清理。扩展重载后的连续性依赖宿主保存的可见历史。

### 上下文计数

文本估算采用 Codex CLI 的 `ceil(UTF-8 字节数 / 4)`；消息、工具封装另计固定开销，文本附件和工具参数采用相同比例，图片独立估算。

| 输入 | 0.1.9 实际计数 |
|---|---:|
| 40 KiB ASCII 字符串 | 10,240 |
| 同一文本作为消息，含格式开销 | 10,264 |
| 同一文本作为 text/plain 附件，含格式开销 | 10,272 |
| `中文🙂`，UTF-8 共 10 字节 | 3 |

计数用于宿主上下文预算，服务端 usage 用于实际用量；模型容量与压缩仍由既有目录适配和 VS Code 宿主管理。

## 已执行验证

环境：Windows、Node v24.19.0；使用已有本地运行时，未安装 npm 依赖。

- `node scripts/check.cjs`：30 个 JavaScript 文件语法、manifest/版本一致性、运行时模块依赖与 Provider 边界检查通过。
- 全部 `.test.cjs` 使用 Node 测试运行器执行：164 项通过，0 失败、0 跳过；包含本次新增的 15 项思考强度、提示词配置与子 agent 路由验证。完整 TAP 输出见 `docs/OFFLINE_TEST_RESULTS.txt`。
- `node scripts/host-smoke.cjs`：在已安装的 VS Code 1.140.0 中验证扩展激活、命令注册、未登录模型发现，以及实际 API 消息转换；宿主进程正常退出。
- VSIX/源码 ZIP 验证见 `docs/PACKAGE_VALIDATION.txt`。

现有 OAuth、OIDC、账户、凭据、模型发现、流处理、取消与扩展 API mock 用例继续通过。此次验证检查聊天配置是否成为实际 API 参数，以及注入指令是否使用宿主可解析的真实模型名称；既有响应重放与回合继续行为保持通过。

## 尚未执行的真实联调

- 打包 VSIX 的原生聊天完整收发及在线多轮消息序列化。
- 真实 ChatGPT OAuth、账号模型目录及在线 Responses 推理。
- 原生 Agent 文件编辑、终端、MCP、diff 与审批循环。
- 原生 SecretStorage、跨窗口一致性、系统代理及远程开发环境。

本版保留显式确认的 `ChatGPT Direct: Test Connection (Uses Plan Usage)` 命令，以及指定现有 VS Code 程序的 `npm run test:host` 入口。真实验收仍应在临时可信项目中完成读取、修改、读取修改结果和继续处理的多轮任务。
