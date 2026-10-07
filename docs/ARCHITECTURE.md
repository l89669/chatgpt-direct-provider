# Architecture / 开发说明

## Entry points

`src/extension.js` composes the native VS Code APIs with an account manager and a public OpenAI transport. `src/vscode/provider.js` implements the three stable model-provider methods. `src/vscode/authentication.js` contributes native account sessions. There is no custom chat participant, webview or embedded agent.

```text
Host context/tool registry → Provider → strict request adapter → public Responses
                                                          ↓
Host tool approval/execution ← validated ToolCallPart ← completed SSE output
```

`src/constants.js` pins the public authorization, token, model and inference URLs. These are not user- or workspace-configurable. Modifying source is required to change this boundary; no private endpoint or API-key compatibility mode exists.

## Account state

`AccountStore` writes one SecretStorage record containing profiles and pending issued registrations. Non-secret host identity is generated only on a new installation and remains stable. Missing host identity while registrations exist is an error, not a reason to silently rebind them.

`Accounts.signIn` starts the browser callback listener, creates PKCE/state/nonce, accepts the dynamically issued client ID, exchanges the code, verifies the identity and saves a new session. A returning registration must retain its verified subject and issued client. Multiple registrations may have the same email. An identity-only grant is retained with plan use disabled. Changing active account/session invalidates models, cancels streams and clears the response replay cache.

Refresh is inside a cross-process lock, re-reads SecretStorage, honors earliest-refresh metadata and stores rotated credentials. Ambiguous token exchange failures are not automatically retried: the server might already have consumed the refresh token. Confirmed terminal refresh errors invalidate tokens while retaining registration identity. Sign-out marks the account unavailable before performing revocation, then removes tokens even when remote revocation cannot be confirmed.

## Model catalog

The catalog adapter expects the documented account-specific `models` array and `visibility: list`. The bundled metadata-only Codex snapshot supplements visible entries absent from the live catalog. Live slugs own all same-name metadata and visibility. normalizeCatalog owns both merging and normalization; client logging records source and supplement count. Names and IDs come from the live account catalog or the identified snapshot. Missing capacity and modality details are not invented: capacity has declared fallbacks, image input is not advertised without evidence. Function tools are available unless catalog metadata explicitly disables them; actual server support still needs live validation. Thinking effort is validated against advertised values.

Model metadata exposes capacity, capabilities and catalog-supported thinking effort through `configurationSchema`. VS Code 1.140.0 forwards this metadata and passes request configuration as `modelConfiguration`; the manifest does not enable API proposals. Internal model metadata is retained within the provider and checked again against the selected account. Cache TTL is 60 seconds, with explicit refresh and account invalidation.

`modelInfo` owns the native Thinking Effort schema. `buildRequest` resolves explicit request options, then chat configuration, then the extension default. Selecting Model default omits the API effort field; selecting Extension default preserves the existing global setting.

`src/protocol/subagent-policy.js` owns the Claude-to-GPT model routing instruction. When runSubagent is exposed, the request adapter inserts this developer instruction after the host's developer messages. Haiku/Sonnet/Opus map to actual agent-capable Luna/Sol/Astra catalog entries in server order, with the parent model used when a family is unavailable. The instruction requires the qualified Model Name (Vendor) in runSubagent.model. Tool parameters remain model-generated and host-executed. The default template is declared in package.json as `chatgptDirect.subagentDeveloperPrompt`, and the policy module renders this same template for requests and model budgets. The provider reads configuration on each request; empty text disables injection and releases the reserve. Configuration changes refresh model metadata through the existing listener.

## Request and stream contracts

The native VS Code host sends `System = 3`, `User = 1`, and `Assistant = 2`. `roleName` maps them to Responses `developer`, `user`, and `assistant`, respectively. This translation preserves the Agent's system instructions and follows the SIWC requirement to send them as developer content.

The request adapter builds an allowlist rather than forwarding arbitrary VS Code options. It uses full history, `store:false`, `stream:true`, namespace function tools and optional catalog-approved reasoning effort. It does not send forbidden ordinary API parameters or rely on persistent `previous_response_id` chaining.

Tool names that do not fit wire syntax receive deterministic collision-checked aliases. The mapping returns each call to its original VS Code tool name. The client never calls a tool implementation itself. Argument data must be JSON objects; the host remains responsible for final schema validation, permissions, confirmation and execution.

The SSE parser handles UTF-8 byte splits and event delimiters. Text can be reported as it arrives, but tool calls remain staged until `response.completed` and batch validation. A subsequent stream error therefore cannot cause an earlier staged call to execute. The completed output supplies call identity; argument-delta events are insufficient for it. Unknown hosted-execution item types are rejected.

`inspectResponseFormat` in the stream adapter confirms SSE from the initial response bytes when Content-Type differs. It retains and replays inspected chunks so the same parser validates the complete response. JSON errors returned before streaming keep their machine code; other non-stream responses expose status, media type, encoding and structure through diagnostics. This inspection performs no additional inference request.

## Multi-turn state

`OpenAIClient.infer` owns a host-visible model response across one or more samples. A completed sample with `end_turn=false` continues with its complete output appended to `input`; intermediate message phases provide a fallback when the flag is absent. A tool-call batch ends this adapter operation so the host can approve and execute it. An affirmative end-turn flag ends sampling. Sampling shares the original deadline, cancellation, account lease and tool definitions.

`ResponseReplayCache` in `src/protocol/history.js` owns complete completed-response output. The client hands it the original `output` array only after completion and call validation. Each record is keyed by account/session/model, a fingerprint of the preceding visible conversation, and the emitted text/tool calls. Adjacent assistant messages and text chunks are normalized for matching; developer instructions stay in the outgoing request and are excluded from response identity because the host can update them between requests.

Outputs from continued samples form one ordered replay record because the host sees one assistant block. The stream consumer merges completed output with already received output items, retaining their phase and reasoning when the final event carries only completion metadata. Protocol diagnostics record each sampling decision and aggregate usage across the host-visible operation.

When a host assistant block matches, `convertMessages` restores the original ordered output array, including assistant `phase`, all encrypted reasoning items, and function calls. Host-provided user messages and tool results are converted separately. This covers text-only answers, multiple message phases, parallel calls, and reasoning after a call. Visible history determines which completed records are eligible for replay, so rewritten or compacted history retains only matching state.

The cache has a 16 MiB payload budget and a 1-hour TTL, and is cleared on account/session changes. Extension reload falls back to the host's saved visible history. The stable Provider interface continues to expose text and tool-call parts.

## Context accounting

`estimateTokens` uses `ceil(UTF-8 bytes / 4)` for strings, text parts, text attachments and tool arguments, following the Codex CLI heuristic. It adds fixed message/tool overhead and estimates images separately. Thus 40 KiB of plain text consumes a 10,240-token text budget. Model capacity and output reserve come from catalog metadata or the configured fallbacks. The VS Code host owns context selection and compaction; server usage remains available through diagnostics.

## Failure and retry policy

Only an explicitly rejected HTTP 503 before the inference stream opens receives one bounded retry. Network ambiguity, interruption after streaming, and failed/incomplete responses do not trigger automatic POST replay. Quota errors pause the account within the current extension process until explicit resume or process restart; this pause is not distributed rate limiting across windows.

Cancellation destroys the local stream and withholds staged tools. It is not a guarantee that the upstream provider has immediately stopped computation or charging. Errors expose sanitized machine diagnostics rather than raw prompt/token-bearing server content.

## Files

| Directory | Responsibility |
|---|---|
| `src/auth/` | OAuth, OIDC verification, profiles, refresh, locking |
| `src/openai/` | Native HTTPS, public catalog, Responses client |
| `src/protocol/` | Message/tool mapping, SSE, complete response replay, token estimation |
| `src/vscode/` | Stable model/account API adapters |
| `test/` | Unit tests, local callback tests, process tests, host API mocks |
| `test/host/` | Optional real-host activation smoke entry point |
| `scripts/` | Dependency-free checks, portable test runner, reproducible VSIX/ZIP |

Runtime and build sources are untransformed JavaScript. There is no TypeScript type-checking claim. No `npm install`, compiled native extension or downloaded build dependency is required for these tests and packages.
