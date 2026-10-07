# ChatGPT Direct Provider

**用 ChatGPT 套餐，在 VS Code 原生 Agent 中工作。**

[下载 VSIX](https://github.com/l89669/chatgpt-direct-provider/releases) · [English](../README.md) · [问题反馈](https://github.com/l89669/chatgpt-direct-provider/issues)

这是一个 VS Code 模型 Provider。通过 OpenAI 的 Sign in with ChatGPT 公共授权流程，把 GPT 模型接入原生 Chat 与 Local Agent；授权应用名称为 **Direct Plan Bridge**。

选择模型后，继续使用 VS Code 原有的文件编辑、终端、MCP、diff 和审批流程。扩展提供模型，宿主负责 Agent 和工具执行。

## 主要能力

- **原生模型选择器**：直接在 ChatGPT Plan · Direct 分组选择模型。
- **聊天思考强度**：Thinking Effort 菜单显示模型实际支持的等级，聊天选择优先于全局默认。
- **多轮状态重放**：保留原始消息 phase、加密 reasoning 和工具调用。
- **目录快照补齐**：实时目录优先，内置 Codex 元数据快照补齐未返回的可见型号。
- **可编辑 developer 提示词**：默认将 Haiku、Sonnet、Opus 子 agent 指定分别映射到 Luna、Sol、Astra。
- **可定位问题的日志**：目录筛选、live/snapshot 来源、实际思考强度、结束状态和输入拒绝结构。

运行时零 npm 依赖，不需要安装 Codex CLI。

## 安装

要求 VS Code 桌面版 **1.138+**，可信工作区及符合条件的 ChatGPT 账号。当前原生宿主验证使用 **1.140.0**。

1. 从 [Releases](https://github.com/l89669/chatgpt-direct-provider/releases) 下载 VSIX，执行 **Extensions: Install from VSIX…** 安装，然后 **Developer: Reload Window**。
2. 执行 **ChatGPT Direct: Continue with ChatGPT**，在浏览器完成 Direct Plan Bridge 的身份与套餐使用授权。
3. 打开原生 Chat，选择 Ask 或本地 Agent，从 **ChatGPT Plan · Direct** 分组选择模型。

请求会消耗 ChatGPT 套餐用量。本项目为非官方预览版，以本地 VSIX 交付。

## 配置

模型配置菜单中的 **Thinking Effort** 支持 Extension default、Model default 和目录声明的具体等级。

设置中搜索 **`chatgptDirect.subagentDeveloperPrompt`**，可直接编辑多行文案。保存后下一次请求生效；留空关闭注入，重置恢复默认。`{{modelRoutes}}` 填入可用模型映射，`{{parentModel}}` 填入当前主模型完整选择器。该策略通过提示词指导模型填写 runSubagent.model，不强制改写工具参数。

实时目录的同名条目始终优先，包括 visibility。快照只补缺少的可见型号，模型是否能被公共推理接口接受由服务端决定。Refresh Models 重新获取目录，Show Diagnostics 打开日志。

## 当前验证状态

164 项离线测试通过；真实 VS Code 宿主已验证模型注册、消息转换、配置传递、提示词编辑、快照模型选择和工具交接。用户已确认 0.1.9 的 GPT-6.1-Sol 与 GPT-6-Astra 在线推理均可用。

完整实现边界与验证范围见 [英文 README](../README.md)、[架构](ARCHITECTURE.md) 和 [验证报告](TEST_REPORT.md)。

## 开发

Node.js **22+**，无需 npm install：

```sh
npm run check
npm test
npm run package
```

产物位于 dist/。在 VS Code 按 F5 启动开发宿主。欢迎聚焦问题的反馈与贡献。
