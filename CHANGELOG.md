# Changelog

## 0.1.9 — 2026-10-07

- 未命中缓存的助手历史文本使用字符串内容，支持切换模型和扩展重载后的历史转换。
- 输入拒绝诊断记录对应项角色和部件类型、实际思考强度。

## 0.1.8 — 2026-10-07

- 内置 Codex 模型目录元数据快照，补齐实时目录未返回的可见型号。
- 实时同名条目保持优先，目录日志标记 live/snapshot 来源与补齐数量。
- 真实 VS Code 宿主验证快照型号可发现、选择并构造相应推理请求。

## 0.1.7 — 2026-10-07

- 增加模型目录请求、HTTP 结果、返回条目及逐项筛选原因诊断。
- 记录目录缓存与最终提交给 VS Code 的模型列表；诊断保留最近目录结果。

## 0.1.6 — 2026-10-07

- developer 子 agent 提示词开放为可编辑的多行设置，现有路由规则作为默认模板。
- 支持实际目录映射和主模型占位符；留空关闭注入，编辑后下一次请求生效。
- 请求注入与上下文预算使用同一渲染内容。

## 0.1.5 — 2026-10-07

- 原生聊天增加 Thinking Effort 配置菜单，所选强度进入 Responses 请求；保留全局默认与模型默认。
- 子 agent 请求追加 developer 路由提示词，将 Haiku/Sonnet/Opus 分别映射到账号目录中的 Luna/Sol/Astra，并要求明确填写模型选择器。
- 在真实 VS Code 1.140.0 模型注册与请求通路验证配置默认值、强度传递和提示词注入。

## 0.1.4 — 2026-10-07

Continue model sampling for `end_turn=false`, or commentary/partial-answer output without an explicit end-turn flag. Append complete intermediate output to the next request; hand tool calls back to VS Code as soon as they are ready. Cache all samples as one host-visible answer and aggregate their usage. Retain streamed output items when completion metadata omits their output payload.

Log response end-turn flags, phases, sample counts and tool handoff decisions. Real VS Code Extension Host verification exercises a commentary response followed by a second sample and native ToolCallPart delivery.

## 0.1.3 — 2026-10-07

Confirm the SSE format from response bytes when Content-Type differs, preserving the inspected bytes for normal event parsing and completion validation. Non-stream JSON errors retain their server error code; other non-stream responses expose HTTP status, media type, encoding, body format and structural diagnostics. Failure state remains distinct from the HTTP status code.

## 0.1.2 — 2026-10-07

Map the native VS Code `System = 3` message role to Responses `developer`, preserving the Agent's system instructions. Real VS Code 1.140.0 Extension Host verification covers activation and native system/user/assistant/tool message conversion. Offline fixtures use the same system-role value.

## 0.1.1 — 2026-10-07

Preserve complete Responses output for both text and tool turns. History replay restores original assistant `phase`, all encrypted reasoning items, and ordered function calls by matching the host's preceding conversation and visible output. Matching is independent of text-stream chunk boundaries and changing developer instructions.

Use the Codex CLI text estimate, `ceil(UTF-8 bytes / 4)`, for text, text attachments, and tool arguments, with separate message overhead and image estimates. Updated offline verification and reproducible VSIX/source packages accompany this release.

## 0.1.0 — 2026-10-06

First local preview. Public SIWC dynamic registration and OAuth; independent multi-account storage; stable VS Code language-model and authentication providers; account-specific model discovery; namespaced function-tool adapter; full visible history and bounded ephemeral encrypted-reasoning replay; HTTP/SSE streaming; cancellation; post-completion tool validation; sanitized diagnostics; opt-in connection test; dependency-free source and reproducible VSIX packaging.

Offline tests and package validation are documented separately from unperformed real-host and live-account verification. This is not a Marketplace release, an official OpenAI/Microsoft extension, a Codex token importer, or a replacement Agent harness.
