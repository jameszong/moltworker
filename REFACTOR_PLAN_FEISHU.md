# 飞书架构重构计划 (Feishu Architecture Refactor Plan)

本文档详细规划了将飞书业务逻辑从 Moltworker 剥离，并迁移至 Sandbox 容器内部 OpenClaw 的架构重构步骤。目标是使 Moltworker 成为纯粹的网关，而由 OpenClaw 承担大模型调度与飞书消息处理的核心职责。

---

## Step 1: 精简 Moltworker (纯粹的网关层)
目前 `moltworker/src/routes/feishu.ts` 中包含了大量业务逻辑（如下载 R2 暂存、调用 DashScope API、创建飞书文档等），这导致了严重的代码耦合。我们需要将其重构为一个纯粹的反向代理。

**具体操作：**
1. **删除冗余代码**：移除 `feishu.ts` 中的 `processPdfAndReply`、`downloadAndSaveFeishuFile`、`getFeishuToken`、`replyFeishuMessage` 等业务函数。
2. **实现请求透传**：将 `POST /feishu/webhook` 的处理逻辑修改为直接获取 `sandbox` 实例，调用 `sandbox.containerFetch`，将请求连同 Headers 和 Body 原封不动地转发给容器内部 OpenClaw 正在监听的端口（通常为 `MOLTBOT_PORT` 的 `/webhooks/feishu` 路径）。
3. **保留必要的鉴权**：Moltworker 层面可以不再做复杂的飞书 Token 校验（交由内部 OpenClaw 的 Adapter 处理），只需确保外网请求能顺利打入 Sandbox 即可。

---

## Step 2: Fork 并魔改 OpenClaw (剥离业务层)
你需要前往 GitHub Fork 官方的 [OpenClaw 仓库](https://github.com/openclaw/openclaw)，在其中实现对飞书的原生支持以及 PDF 总结相关的 Skill。

**具体操作与目录规划：**
1. **实现 Feishu Channel Adapter**：
   在 OpenClaw 源码中创建飞书通道适配器，参考已有的 Telegram 或 Slack 实现。
   - **路径**：`src/channels/feishu/`
   - **核心逻辑**：
     - 实现 `FeishuChannel` 类继承 OpenClaw 的基础 Channel 接口。
     - 启动一个本地的 HTTP 路由（如 `/webhooks/feishu`）来接收从 Moltworker 透传过来的请求。
     - 正确处理飞书的 `url_verification` Challenge。
     - 解析 `im.message.receive_v1` 事件，将飞书的消息和文件事件转换为 OpenClaw 内部标准的 Agent 消息流。
2. **实现 PDF Analyzer Skill**：
   将之前的 DashScope (`qwen-long`) PDF 解析逻辑封装为一个原生的 OpenClaw Skill。
   - **路径**：`src/skills/pdf-analyzer/`
   - **核心逻辑**：
     - 接收输入的文件（通过 Feishu Channel 下载的资源）。
     - 调用 DashScope API 上传并提取摘要。
     - 生成分析报告并通过飞书的 API 返回给用户（或通过 OpenClaw 标准消息协议回复，并附带富文本格式）。

---

## Step 3: 修改 Moltworker 镜像配置 (镜像替换)
为了让 Sandbox 运行我们魔改后的 OpenClaw，我们需要修改 Moltworker 项目中的构建流程和环境变量配置。

**具体操作：**
1. **修改 `Dockerfile`**：
   - 移除原来的 `npm install -g openclaw`。
   - 替换为拉取你自己 Fork 的仓库代码并从源码编译安装。例如：
     ```dockerfile
     RUN git clone https://github.com/your-username/openclaw.git /opt/openclaw
     WORKDIR /opt/openclaw
     RUN npm install && npm run build
     RUN npm link
     ```
2. **环境变量与启动脚本适配**：
   - 修改 `src/types.ts` 和 `src/gateway/env.ts`，确保 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN` 等变量能够通过 `envVars` 正确传递给 Sandbox 容器。
   - 修改 `start-openclaw.sh`：在生成或 patch `openclaw.json` 配置时，将飞书相关的配置块动态注入到 `channels.feishu` 中，让 OpenClaw 在启动时加载飞书适配器。

---
**执行建议**：
建议严格按照 1 -> 2 -> 3 的顺序进行验证。首先 Fork 代码并在本地跑通飞书 Channel 的最小化 MVP（例如能收到消息并回复 "Hello"），然后修改 Moltworker 的 Dockerfile 和反向代理路由进行集成测试，最后再将复杂的 PDF 处理逻辑以 Skill 的形式迁移进去。
