<div align="center">

# ChatGPT Direct Provider

### Your ChatGPT plan. VS Code’s native Agent.

Bring GPT models into the editor you already use — with native tools, model switching, and thinking effort controls.

[![Version](https://img.shields.io/badge/preview-v0.1.9-10a37f)](https://github.com/l89669/chatgpt-direct-provider/releases/tag/v0.1.9)
[![VS Code](https://img.shields.io/badge/VS_Code-1.138%2B-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-zero-10a37f)](package.json)

[Download](https://github.com/l89669/chatgpt-direct-provider/releases) · [中文](docs/README.zh-CN.md) · [Report an issue](https://github.com/l89669/chatgpt-direct-provider/issues)

</div>

**ChatGPT Direct Provider** is a VS Code extension that connects your ChatGPT plan to **native Chat and Local Agent** through OpenAI’s public **Sign in with ChatGPT** flow. Its authorization application is named **Direct Plan Bridge**.

Pick a GPT model in the regular model picker and keep working with VS Code’s file edits, terminal, MCP tools, diffs, and approval flow. The extension supplies the model; VS Code runs the agent.

## What makes it useful

| Feature | What you get |
|---|---|
| **Native Agent experience** | GPT models in the existing Chat UI, using tools and context supplied by the host. |
| **ChatGPT plan access** | Browser sign-in and a separate plan-usage grant. No API key required for this route. |
| **Thinking effort in chat** | A native **Thinking Effort** menu populated with the selected model’s supported levels. |
| **Better multi-turn continuity** | Complete Responses output replay, preserving message phases, encrypted reasoning, and tool calls. |
| **Model catalog supplementation** | Live account metadata takes priority; a bundled Codex metadata snapshot fills missing visible models. |
| **Editable developer prompt** | Customize subagent routing directly in settings. Defaults map Haiku → Luna, Sonnet → Sol, and Opus → Astra. |
| **Useful diagnostics** | See model sources, catalog filtering, actual effort, sampling decisions, and rejected input structure. |

The runtime uses plain CommonJS JavaScript and Node built-ins. No Codex CLI installation, credential import, custom chat webview, or runtime npm dependencies are required.

## Get started

**Requirements:** VS Code desktop **1.138+**, a trusted workspace, and an eligible ChatGPT account. Native Local Agent availability also depends on the VS Code host and its policies. The current integration was verified on **VS Code 1.140.0**.

1. Download `chatgpt-direct-provider-0.1.9.vsix` from [Releases](https://github.com/l89669/chatgpt-direct-provider/releases).
2. Run **Extensions: Install from VSIX…**, then **Developer: Reload Window**.
3. Run **ChatGPT Direct: Continue with ChatGPT** and complete the browser authorization for **Direct Plan Bridge**, including plan usage.
4. Open native Chat, choose **Ask** or local **Agent**, and select a model under **ChatGPT Plan · Direct**.

Optional: run **ChatGPT Direct: Test Connection (Uses Plan Usage)** for an explicitly confirmed small inference request.

```sh
code --install-extension ./chatgpt-direct-provider-0.1.9.vsix
```

Requests consume your ChatGPT plan usage. This is an **unofficial preview**, not an OpenAI or Microsoft product, and is distributed as a local VSIX rather than a Marketplace extension.

## Make it yours

### Choose how hard the model thinks

Open the selected model’s configuration menu and choose **Thinking Effort**:

- **Extension default** uses the global `chatgptDirect.reasoningEffort` setting.
- **Model default** lets the backend choose the effort.
- **Low / Medium / High / Extra high / …** appear only when advertised by that model.

Your chat choice takes priority over the global fallback. An explicit request-level option takes priority over both.

### Edit the subagent developer prompt

Search settings for **`chatgptDirect.subagentDeveloperPrompt`** and edit the multiline text. Changes apply to the next request; reset the setting to restore the default, or set it to an empty string to disable injection.

The default template contains two optional placeholders:

| Placeholder | Rendered value |
|---|---|
| `{{modelRoutes}}` | Available Haiku/Luna, Sonnet/Sol, and Opus/Astra model mappings. |
| `{{parentModel}}` | The current parent model’s qualified `Model Name (Vendor)` selector. |

The instruction is added when the host exposes `runSubagent`. Routing is prompt-based: the model generates the tool arguments, and VS Code creates and executes the subagent.

### Understand the model list

The extension fetches the account’s live catalog from `/v1/models`, then appends missing visible models from a bundled metadata-only Codex snapshot. Live entries own same-name metadata **and visibility**. Snapshot entries are labeled in model details and logs; their inclusion in the picker does not guarantee admission by the inference endpoint.

Run **ChatGPT Direct: Refresh Models** to refetch. **ChatGPT Direct: Show Diagnostics** opens the output channel with per-model filtering and source information.

## How it fits together

```text
VS Code native Chat / Local Agent
             │ context, history, tool definitions
             ▼
     LanguageModelChatProvider
             │ browser authorization + protocol adapter
             ▼
      OpenAI public SIWC API
        /v1/models · /v1/responses
             │ streamed text and validated tool calls
             ▼
 VS Code tool approval and execution
```

The host owns context selection, compaction, and tools. The provider owns authentication, model metadata, request conversion, streaming, and in-memory response replay. Text budgets use `ceil(UTF-8 bytes / 4)`; actual usage comes from the server.

This extension covers model-provider integration. Inline completions, Next Edit Suggestions, GitHub cloud agents, hosted OpenAI tools, and visible reasoning-text rendering are outside the current implementation. [Architecture](docs/ARCHITECTURE.md) explains the boundaries.

## Project status

| Evidence | Status |
|---|---|
| Offline checks | **164 tests passing**, plus syntax and package validation. |
| Real VS Code host | Native registration, message conversion, thinking configuration, editable prompts, snapshot models, and tool handoff verified with synthetic transport. |
| Live user validation | **GPT-6.1-Sol and GPT-6-Astra inference confirmed working** by the user on version 0.1.9. |

See the [validation report](docs/TEST_REPORT.md) for the scope of each check. Real-host checks and live-account behavior are reported separately.

## Build and contribute

Use **Node.js 22+**. No `npm install` is needed.

```sh
git clone https://github.com/l89669/chatgpt-direct-provider.git
cd chatgpt-direct-provider
npm run check
npm test
npm run package
```

The build produces a VSIX and source ZIP under `dist/`. Press **F5** in VS Code to launch the development extension host. To run the real-host smoke check, set `VSCODE_EXECUTABLE` to your existing VS Code desktop executable, then run `npm run test:host`; this check does not sign in or consume plan usage.

Bug reports are most useful with the extension and VS Code versions, selected model, error code/parameter, and relevant sanitized diagnostic entries. Please keep tokens, authorization URLs, and private conversation content out of public issues.

Read the [architecture](docs/ARCHITECTURE.md), [privacy policy](PRIVACY.md), and [security notes](SECURITY.md) before changing the integration. Small, focused fixes and reproducible reports are welcome.
