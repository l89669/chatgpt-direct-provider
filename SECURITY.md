# Security / 安全边界

此版本未经过第三方安全审计。已有用户确认 GPT-6.1-Sol 与 GPT-6-Astra 在线推理可用，完整账号、工具和审批流程的验收范围见验证报告。安全机制有离线回归测试，不等于已经证明不存在漏洞。

## 已实现的防护

授权请求使用新随机 state、OIDC nonce、PKCE S256；监听器只绑定 127.0.0.1，并校验 Host、路径、参数重复与 state。首次注册返回的正式 client ID 才可换令牌；回访注册不得换身份。基于可信 discovery/JWKS 验证 RSA/EC 签名、签名算法、issuer、audience、subject、过期时间、nonce。禁止 alg none/HS256 混淆，不关闭 HTTPS 验证。

所有带凭据的远程请求限定于固定 OpenAI HTTPS origins，不允许用户输入任意 inference endpoint，不跟随重定向。没有读取其他软件 token 的逻辑，也没有 API key 回退。

跨进程 mkdir 文件锁串行化本地凭据读改写和刷新，活 PID 的锁不会因时间久而被抢占。死亡 PID 的锁在单独 recovery guard 中二次确认后清理。缺失或损坏的所有者记录失败关闭而非冒险抢锁。轮换后的凭据作为单条 SecretStorage 记录保存。信任边界是同一台机器、同一用户的受保护存储；锁不是恶意本地用户隔离设施。

模型只能请求当前宿主提供的工具。扩展检查名称映射、namespace、call ID、参数对象和重复 ID。所有工具必须等 response.completed 后整批验证通过，才成为 VS Code ToolCallPart。扩展自身不执行 shell、MCP 或编辑操作；参数 schema 的最终校验及批准仍由调用工具的宿主负责。没有声称阻止所有 prompt injection；项目内容可影响模型，审批仍很重要。

## 特别注意

修改项目源码、安装其他扩展或改变操作系统凭据后端都可能改变信任条件。不要公开 SecretStorage 内容、授权/回调 URL、完整 ID token、终端/工作区敏感内容或真实测试账户。

不能只把私有 API URL 换成 public API URL 就称为 SIWC；client、grant、scope、resource、身份和 host 绑定必须一致。身份验证失败时应修规范或配置，不移除验证。

首次真实验收先在临时项目进行。确认工具仍走原生审批和 diff，取消后不继续动作，再用于正式仓库。问题报告可提供版本、匿名错误码和 request ID；一般问题可提交到 https://github.com/l89669/chatgpt-direct-provider/issues；不要在公开 issue 中附上凭据或可利用的安全细节。
