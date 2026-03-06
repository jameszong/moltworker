import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ensureMoltbotGateway } from '../gateway';
import { sendFeishuMessage, getTenantAccessToken } from '../services/feishu-api';
import puppeteer from '@cloudflare/puppeteer';

/**
 * Tool definitions for Function Calling
 */
const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'web_scrape',
      description: '抓取网页内容并提取文本。当用户询问网页内容、需要访问URL获取信息时使用此工具。',
      parameters: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string' as const,
            description: '要抓取的网页URL',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_feishu_doc',
      description: '创建飞书文档（将自动为组织内所有用户授予可编辑/管理权限）。当用户要求将内容保存为飞书文档、生成文档或创建文档时使用此工具。',
      parameters: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string' as const,
            description: '文档标题',
          },
          content: {
            type: 'string' as const,
            description: '文档内容（支持Markdown格式）',
          },
          folder_token: {
            type: 'string' as const,
            description: '可选的文件夹token，用于指定文档保存位置',
          },
        },
        required: ['title', 'content'],
      },
    },
  },
];

/**
 * Feishu Webhook routes
 * This is now a pure reverse proxy forwarding events to the OpenClaw container.
 */
export const feishu = new Hono<AppEnv>();

feishu.post('/webhook', async (c) => {
  try {
    const sandbox = c.get('sandbox');
    if (!sandbox) {
      return c.json({ error: 'Sandbox not initialized' }, 500);
    }

    // Parse the request body
    const contentType = c.req.raw.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return c.json({ error: 'Invalid content type' }, 400);
    }

    const body = await c.req.json();

    // Handle url_verification challenge
    if (body && typeof body === 'object' && body.type === 'url_verification' && body.challenge) {
      console.log('[Feishu] Handling url_verification challenge');
      return c.json({ challenge: body.challenge });
    }

    // Handle real chat message events (im.message.receive_v1)
    if (body && typeof body === 'object' && body.header?.event_type === 'im.message.receive_v1') {
      const event = body.event;
      const message = event?.message;
      const sender = event?.sender;

      // Extract user ID (open_id or union_id)
      const openId = sender?.sender_id?.open_id;
      const unionId = sender?.sender_id?.union_id;
      const userId = openId || unionId || 'unknown';

      // Extract text content
      let textContent = '';
      if (message?.content) {
        try {
          const content = JSON.parse(message.content);
          textContent = content.text || '';
        } catch (e) {
          // If not JSON, use raw content
          textContent = message.content;
        }
      }

      console.log(`[Feishu] Received message from user ${userId}: ${textContent}`);

      // Return HTTP 200 immediately to avoid Feishu retry
      // The AI response will be sent asynchronously
      // Use waitUntil with a timeout wrapper for Paid Plan longer execution
      const processingPromise = handleFeishuMessageWithTimeout(
        c.env,
        openId || unionId || '',
        textContent,
        55000,
      );
      c.executionCtx.waitUntil(processingPromise);

      return c.body(null, 200);
    }

    // Handle drive.file.permission_member_applied_v1 event - auto-grant manager permission
    if (body && typeof body === 'object' && body.header?.event_type === 'drive.file.permission_member_applied_v1') {
      console.log('[Feishu] Handling permission member applied event');
      
      const event = body.event;
      const fileToken = event?.file_token;
      const fileType = event?.file_type || 'docx';
      const applicantInfo = event?.applicant;
      
      if (!fileToken || !applicantInfo) {
        console.error('[Feishu] Missing file_token or applicant info in permission event');
        return c.json({ code: 0, msg: 'success' }); // Return success to avoid retry
      }
      
      console.log(`[Feishu] Permission applied for file: ${fileToken}, applicant:`, applicantInfo);
      
      // Process the permission grant asynchronously
      const processingPromise = processPermissionApplication(
        c.env,
        fileToken,
        fileType,
        applicantInfo
      );
      c.executionCtx.waitUntil(processingPromise);
      
      // Return success immediately to avoid retry
      return c.json({ code: 0, msg: 'success' });
    }
    await ensureMoltbotGateway(sandbox, c.env);

    const originalUrl = new URL(c.req.url);
    const containerUrl = new URL(originalUrl.toString());
    containerUrl.pathname = '/webhooks/feishu';

    // Need to re-create the request since body was already consumed
    const containerReq = new Request(containerUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });

    console.log('[Feishu] Proxying webhook to container port 3000...');

    const containerRes = await sandbox.containerFetch(containerReq, 3000);

    return containerRes;
  } catch (error) {
    console.error('[Feishu] Webhook proxy error:', error);
    return c.json({ error: 'Internal server error during proxying' }, 500);
  }
});

feishu.get('/fix-docs', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  // Get userOpenId from query param to add explicit permission
  const userOpenId = c.req.query('user');

  const docs = [
    'Y3SrdNfAholnFcxJT2LcY5bhn3g',
    'FWtFdchPuo5mJExs6BXcqH7YnQh',
    'YcVndy09FoeJ8fxTuNpcHGP9nOf'
  ];

  const results = [];
  for (const docId of docs) {
    try {
      // Try 1: PATCH public permission with type=docx
      const permUrl = `https://open.feishu.cn/open-apis/drive/v2/permissions/${docId}/public?type=docx`;
      const response = await fetch(permUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          external_access: true,
          security_entity: 'anyone_can_view',
          share_entity: 'anyone',
          link_share_entity: 'anyone_editable',
          invite_external: true
        }),
      });
      const data = await response.json();
      
      // Try 2: Add explicit member permission if userOpenId provided
      let memberResult = null;
      if (userOpenId) {
        try {
          const memberUrl = `https://open.feishu.cn/open-apis/drive/v1/permissions/${docId}/members?type=docx`;
          const memberResponse = await fetch(memberUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              members: [
                {
                  member_type: 'user',
                  member_id: userOpenId,
                  perm: 'full_access'
                }
              ]
            }),
          });
          memberResult = await memberResponse.json();
        } catch (memberErr: unknown) {
          memberResult = { error: memberErr instanceof Error ? memberErr.message : 'Unknown error' };
        }
      }
      
      results.push({ 
        docId, 
        status: response.status, 
        data,
        memberPermission: memberResult,
        fixUrl: `https://moltbot-sandbox.wowmade.cn/feishu/fix-doc-single?docId=${docId}&user=${userOpenId || ''}`
      });
    } catch (e: unknown) {
      results.push({ docId, error: e instanceof Error ? e.message : 'Unknown error' });
    }
  }

  return c.json({ 
    results,
    note: 'If documents still 404, try accessing the fixUrl for individual doc fix with your user openid'
  });
});

// Single document fix endpoint with explicit user permission
feishu.get('/fix-doc-single', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  const docId = c.req.query('docId');
  const userOpenId = c.req.query('user');
  
  if (!docId) return c.json({ error: 'Missing docId' });

  const results: Record<string, unknown> = {};

  // Try with type=docx
  try {
    const permUrl = `https://open.feishu.cn/open-apis/drive/v2/permissions/${docId}/public?type=docx`;
    const response = await fetch(permUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        external_access: true,
        security_entity: 'anyone_can_view',
        share_entity: 'anyone',
        link_share_entity: 'anyone_editable',
        invite_external: true
      }),
    });
    results.docx = { status: response.status, data: await response.json() };
  } catch (e: unknown) {
    results.docx = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  // Try with type=doc
  try {
    const permUrl = `https://open.feishu.cn/open-apis/drive/v2/permissions/${docId}/public?type=doc`;
    const response = await fetch(permUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        external_access: true,
        security_entity: 'anyone_can_view',
        share_entity: 'anyone',
        link_share_entity: 'anyone_editable',
        invite_external: true
      }),
    });
    results.doc = { status: response.status, data: await response.json() };
  } catch (e: unknown) {
    results.doc = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  // Add explicit member permission if userOpenId provided
  if (userOpenId) {
    try {
      const memberUrl = `https://open.feishu.cn/open-apis/drive/v1/permissions/${docId}/members?type=docx`;
      const memberResponse = await fetch(memberUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          members: [
            {
              member_type: 'user',
              member_id: userOpenId,
              perm: 'full_access'
            }
          ]
        }),
      });
      results.member = { status: memberResponse.status, data: await memberResponse.json() };
    } catch (e: unknown) {
      results.member = { error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  return c.json({ docId, userOpenId, results });
});

// Delete document endpoint
feishu.get('/delete-doc', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  const docId = c.req.query('docId');
  if (!docId) return c.json({ error: 'Missing docId parameter' });

  try {
    const deleteUrl = `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`;
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 200) {
      return c.json({ docId, deleted: true, status: response.status });
    } else {
      const data = await response.json().catch(() => null);
      return c.json({ docId, deleted: false, status: response.status, error: data });
    }
  } catch (e: unknown) {
    return c.json({ docId, deleted: false, error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

// Transfer owner endpoint - transfer document ownership to specified user
feishu.get('/transfer-owner', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  const docId = c.req.query('docId');
  const ownerId = c.req.query('ownerId') || '9b757773'; // Default to user specified

  if (!docId) return c.json({ error: 'Missing docId parameter' });

  try {
    // Use the transfer owner API
    const transferUrl = `https://open.feishu.cn/open-apis/drive/v1/permissions/${docId}/owner?type=docx`;
    const response = await fetch(transferUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        owner: {
          member_type: 'user',
          member_id: ownerId
        }
      }),
    });

    const data = await response.json().catch(() => null) as { code?: number; msg?: string; data?: unknown } | null;
    
    if (response.status === 200 && data?.code === 0) {
      return c.json({ 
        docId, 
        newOwner: ownerId,
        transferred: true, 
        status: response.status,
        data 
      });
    } else {
      return c.json({ 
        docId, 
        newOwner: ownerId,
        transferred: false, 
        status: response.status, 
        error: data 
      });
    }
  } catch (e: unknown) {
    return c.json({ 
      docId, 
      newOwner: ownerId,
      transferred: false, 
      error: e instanceof Error ? e.message : 'Unknown error' 
    });
  }
});

// Subscribe to drive document events
feishu.get('/subscribe-drive-events', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  try {
    // Subscribe to drive.file.permission_member_applied_v1 event
    // This is required in addition to standard event subscription
    const subscribeUrl = 'https://open.feishu.cn/open-apis/drive/v1/events/subscriptions';
    const response = await fetch(subscribeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        events: [
          {
            event_type: 'drive.file.permission_member_applied_v1'
          }
        ]
      }),
    });

    const data = await response.json().catch(() => null) as { 
      code?: number; 
      msg?: string; 
      data?: { 
        subscriptions?: Array<{event_type: string; status: string}> 
      } 
    } | null;
    
    if (response.status === 200 && data?.code === 0) {
      return c.json({ 
        subscribed: true, 
        status: response.status,
        subscriptions: data?.data?.subscriptions,
        data 
      });
    } else {
      return c.json({ 
        subscribed: false, 
        status: response.status, 
        error: data 
      });
    }
  } catch (e: unknown) {
    return c.json({ 
      subscribed: false, 
      error: e instanceof Error ? e.message : 'Unknown error' 
    });
  }
});

// List current drive event subscriptions
feishu.get('/list-drive-subscriptions', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  try {
    const listUrl = 'https://open.feishu.cn/open-apis/drive/v1/events/subscriptions';
    const response = await fetch(listUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json().catch(() => null);
    
    return c.json({ 
      status: response.status,
      data 
    });
  } catch (e: unknown) {
    return c.json({ 
      error: e instanceof Error ? e.message : 'Unknown error' 
    });
  }
});

// Diagnostic endpoint - check document info and permissions
feishu.get('/doc-info', async (c) => {
  const token = await getTenantAccessToken(c.env);
  if (!token) return c.json({ error: 'No token' });

  const docId = c.req.query('docId');
  if (!docId) return c.json({ error: 'Missing docId parameter' });

  const results: Record<string, unknown> = {};

  // 1. Try to get document metadata
  try {
    const metaUrl = `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`;
    const metaResponse = await fetch(metaUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    results.document = {
      status: metaResponse.status,
      data: await metaResponse.json().catch(() => null)
    };
  } catch (e: unknown) {
    results.document = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  // 2. Try to get document permissions
  try {
    const permUrl = `https://open.feishu.cn/open-apis/drive/v2/permissions/${docId}/public?type=docx`;
    const permResponse = await fetch(permUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    results.permissions = {
      status: permResponse.status,
      data: await permResponse.json().catch(() => null)
    };
  } catch (e: unknown) {
    results.permissions = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  // 3. Try to list document members
  try {
    const membersUrl = `https://open.feishu.cn/open-apis/drive/v1/permissions/${docId}/members?type=docx`;
    const membersResponse = await fetch(membersUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    results.members = {
      status: membersResponse.status,
      data: await membersResponse.json().catch(() => null)
    };
  } catch (e: unknown) {
    results.members = { error: e instanceof Error ? e.message : 'Unknown error' };
  }

  return c.json({ docId, results });
});

/**
 * Handle a Feishu message with timeout wrapper for Paid Plan
 */
async function handleFeishuMessageWithTimeout(
  env: AppEnv['Bindings'],
  userOpenId: string,
  userMessage: string,
  timeoutMs: number,
): Promise<void> {
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('AI processing timeout')), timeoutMs);
  });

  try {
    await Promise.race([handleFeishuMessage(env, userOpenId, userMessage), timeoutPromise]);
  } catch (error) {
    console.error('[Feishu] Message processing timed out or failed:', error);
    // Send timeout message to user
    try {
      await sendFeishuMessage(env, userOpenId, '抱歉，请求处理超时，请稍后重试或简化您的问题。');
    } catch (sendError) {
      console.error('[Feishu] Failed to send timeout message:', sendError);
    }
  }
}

/**
 * Handle a Feishu message: call AI with tool support and send the response back
 * Supports multi-turn conversation with KV storage
 */
async function handleFeishuMessage(
  env: AppEnv['Bindings'],
  userOpenId: string,
  userMessage: string,
): Promise<void> {
  try {
    // Load conversation history from KV
    const conversationKey = `feishu:conversation:${userOpenId}`;
    let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    try {
      const history = await env.CONVERSATION_KV.get(conversationKey);
      if (history) {
        messages = JSON.parse(history);
        console.log(
          `[Feishu] Loaded conversation history for ${userOpenId}, ${messages.length} messages`,
        );
      }
    } catch (kvError) {
      console.error('[Feishu] Failed to load conversation history:', kvError);
    }

    // If no history, start fresh with system prompt
    if (messages.length === 0) {
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      messages = [
        {
          role: 'system',
          content: `你是一个 helpful assistant。你当前的运行时间由系统实时提供，现在是 ${now}。请优先参考此时间。如果需要获取网页内容来获取信息，请使用 web_scrape 工具。如果用户要求创建飞书文档，请使用 create_feishu_doc 工具。记住对话上下文，用户可以基于之前的内容继续提问。`,
        },
      ];
    }

    // Add user message
    messages.push({ role: 'user', content: userMessage });

    // Call AI with tool support (up to 3 tool call rounds)
    let finalResponse = '';
    let toolResults: Array<{ toolName: string; result: string }> = [];

    for (let round = 0; round < 3; round++) {
      // Use timeout wrapper for Paid Plan longer execution
      const result = await callAIWithToolsTimeout(env, messages, TOOLS, 30000);

      if (result.type === 'message') {
        finalResponse = result.content;
        break;
      }

      if (result.type === 'tool_calls') {
        // Execute tools and add results to conversation
        for (const toolCall of result.toolCalls) {
          if (toolCall.function.name === 'web_scrape') {
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`[Tool] web_scrape: ${args.url}`);

            const scrapeResult = await executeWebScrape(env, args.url);
            toolResults.push({ toolName: 'web_scrape', result: scrapeResult });

            // Add tool result to conversation
            messages.push(
              { role: 'assistant', content: `我将抓取网页: ${args.url}` },
              { role: 'user', content: `[网页抓取结果]\n${scrapeResult}` },
            );
          } else if (toolCall.function.name === 'create_feishu_doc') {
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`[Tool] create_feishu_doc: ${args.title}`);

            const docResult = await executeCreateFeishuDoc(
              env,
              args.title,
              args.content,
              userOpenId,
              args.folder_token,
            );
            toolResults.push({ toolName: 'create_feishu_doc', result: docResult });

            // Add tool result to conversation
            messages.push(
              { role: 'assistant', content: `我将创建飞书文档: ${args.title}` },
              { role: 'user', content: `[创建飞书文档结果]\n${docResult}` },
            );
          }
        }
      }
    }

    if (!finalResponse) {
      finalResponse = '抱歉，处理您的请求时出现了问题。';
    }

    // Add assistant response to conversation
    messages.push({ role: 'assistant', content: finalResponse });

    // Save conversation history to KV (keep last 20 messages to avoid size limits)
    try {
      const trimmedMessages = messages.slice(-20);
      await env.CONVERSATION_KV.put(conversationKey, JSON.stringify(trimmedMessages), {
        expirationTtl: 86400, // 24 hours
      });
      console.log(`[Feishu] Saved conversation history for ${userOpenId}`);
    } catch (kvError) {
      console.error('[Feishu] Failed to save conversation history:', kvError);
    }

    // Send the AI response back to the user
    const sent = await sendFeishuMessage(env, userOpenId, finalResponse);
    if (!sent) {
      console.error('[Feishu] Failed to send AI response to user:', userOpenId);
    } else {
      console.log('[Feishu] AI response sent successfully to user:', userOpenId);
    }
  } catch (error) {
    console.error('[Feishu] Error handling message:', error);
    try {
      await sendFeishuMessage(env, userOpenId, '抱歉，系统遇到了问题，请稍后再试。');
    } catch (sendError) {
      console.error('[Feishu] Failed to send error message:', sendError);
    }
  }
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Call AI API with timeout (with tool support)
 */
async function callAIWithToolsTimeout(
  env: AppEnv['Bindings'],
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tools: typeof TOOLS,
  timeoutMs: number,
): Promise<{ type: 'message'; content: string } | { type: 'tool_calls'; toolCalls: ToolCall[] }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      callAIWithTools(env, messages, tools, controller.signal),
      new Promise<{ type: 'message'; content: string }>((_, reject) => {
        setTimeout(() => reject(new Error('AI call timeout')), timeoutMs);
      }),
    ]);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'AI call timeout') {
      return { type: 'message', content: '抱歉，AI 响应超时，请稍后重试或简化您的问题。' };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Call AI with tool support (Function Calling)
 */
async function callAIWithTools(
  env: AppEnv['Bindings'],
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tools: typeof TOOLS,
  signal?: AbortSignal,
): Promise<{ type: 'message'; content: string } | { type: 'tool_calls'; toolCalls: ToolCall[] }> {
  // Priority 3: DashScope (Aliyun) - supports function calling
  if (env.DASHSCOPE_API_KEY) {
    return await callDashScopeWithTools(
      env.DASHSCOPE_API_KEY,
      env.DASHSCOPE_MODEL || 'qwen-plus',
      messages,
      tools,
      signal,
    );
  }

  // Fallback: regular call without tools
  const lastMessage = messages[messages.length - 1]?.content || '';
  const response = await callAI(env, lastMessage, signal);
  return { type: 'message', content: response };
}

/**
 * Call DashScope with function calling support
 */
async function callDashScopeWithTools(
  apiKey: string,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  tools: typeof TOOLS,
  signal?: AbortSignal,
): Promise<{ type: 'message'; content: string } | { type: 'tool_calls'; toolCalls: ToolCall[] }> {
  try {
    const response = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          tools: tools,
          max_tokens: 2000,
        }),
        signal,
      },
    );

    if (!response.ok) {
      console.error('[AI] DashScope API error:', response.status, response.statusText);
      return { type: 'message', content: '抱歉，AI 服务暂时不可用。' };
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: ToolCall[];
        };
      }>;
      error?: { message?: string };
    };

    if (data.error) {
      console.error('[AI] DashScope error:', data.error);
      return { type: 'message', content: '抱歉，AI 处理消息时出错了。' };
    }

    const message = data.choices?.[0]?.message;

    // Check if AI wants to call tools
    if (message?.tool_calls && message.tool_calls.length > 0) {
      return { type: 'tool_calls', toolCalls: message.tool_calls };
    }

    // Regular message response
    const content = message?.content;
    if (!content) {
      return { type: 'message', content: '抱歉，AI 没有生成回复。' };
    }

    return { type: 'message', content };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { type: 'message', content: '抱歉，AI 请求已超时。' };
    }
    console.error('[AI] DashScope exception:', error);
    return { type: 'message', content: '抱歉，调用 AI 服务时发生错误。' };
  }
}

/**
 * Execute web scraping tool using puppeteer
 */
async function executeWebScrape(env: AppEnv['Bindings'], url: string): Promise<string> {
  if (!env.BROWSER) {
    return '错误: Browser Rendering 未配置。请在 Cloudflare Dashboard 中启用 Browser Rendering。';
  }

  let browser;
  try {
    console.log(`[WebScrape] Starting to scrape: ${url}`);

    // Launch browser using puppeteer
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    // Navigate to URL with timeout
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // Get page content
    const title = await page.title();
    const content = await page.evaluate(() => {
      // Extract main content - prioritize article/main content
      const selectors = [
        'article',
        'main',
        '[role="main"]',
        '.content',
        '.post-content',
        '.entry-content',
        '#content',
        'body',
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector) as HTMLElement | null;
        if (element) {
          // Get text content, cleaning up whitespace
          const text = element.innerText
            .replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n')
            .trim();

          if (text.length > 100) {
            return text.substring(0, 8000); // Limit content length
          }
        }
      }

      return document.body.innerText.substring(0, 8000);
    });

    const result = `标题: ${title}\n\n内容:\n${content}`;
    console.log(`[WebScrape] Successfully scraped ${url}, content length: ${content.length}`);

    return result;
  } catch (error) {
    console.error('[WebScrape] Error:', error);
    return `抓取网页时出错: ${error instanceof Error ? error.message : '未知错误'}`;
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error('[WebScrape] Error closing browser:', e));
    }
  }
}

/**
 * Execute create Feishu document tool
 */
async function executeCreateFeishuDoc(
  env: AppEnv['Bindings'],
  title: string,
  content: string,
  userOpenId: string,
  folderToken?: string,
): Promise<string> {
  try {
    console.log(`[FeishuDoc] Creating document: ${title}`);

    const token = await getTenantAccessToken(env);
    if (!token) {
      return '错误: 无法获取飞书访问令牌，请检查 FEISHU_APP_ID 和 FEISHU_APP_SECRET 配置。';
    }

    // Create document
    const createUrl = 'https://open.feishu.cn/open-apis/docx/v1/documents';
    const createBody: Record<string, unknown> = {
      title: title,
    };
    if (folderToken) {
      createBody.folder_token = folderToken;
    }

    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    });

    if (!createResponse.ok) {
      console.error(
        '[FeishuDoc] Failed to create document:',
        createResponse.status,
        createResponse.statusText,
      );
      const errorText = await createResponse.text();
      console.error('[FeishuDoc] Error details:', errorText);
      return `创建飞书文档失败: ${createResponse.status} ${createResponse.statusText}`;
    }

    const createData = (await createResponse.json()) as {
      code?: number;
      msg?: string;
      data?: {
        document?: {
          document_id: string;
          title: string;
          url?: string;
        };
      };
    };

    if (createData.code !== 0) {
      console.error('[FeishuDoc] API error:', createData.msg);
      return `创建飞书文档失败: ${createData.msg || '未知错误'}`;
    }

    const documentId = createData.data?.document?.document_id;
    const documentUrl =
      createData.data?.document?.url || `https://feishu.cn/docx/${documentId}`;

    if (!documentId) {
      return '错误: 无法获取文档ID';
    }

    console.log(`[FeishuDoc] Document created: ${documentId}`);

    // Add content to document (convert markdown-like content to blocks)
    // For simplicity, we'll add the content as a single text block
    // Note: The parent block ID for the document root is the document_id itself
    const blocksUrl = `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
    const blocksResponse = await fetch(blocksUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        children: [
          {
            block_type: 2, // Text block
            text: {
              elements: [
                {
                  text_run: {
                    content: content,
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    if (!blocksResponse.ok) {
      console.error(
        '[FeishuDoc] Failed to add content:',
        blocksResponse.status,
        blocksResponse.statusText,
      );
      // Document was created but content failed, still return document URL
      return `飞书文档已创建: ${documentUrl}\n\n但添加内容时出错。您可以手动编辑文档添加内容。`;
    }

    console.log(`[FeishuDoc] Content added to document: ${documentId}`);
    
    // Note: Document permissions are handled separately via fix-docs endpoint if needed
    // The document creator (this app) has full access by default

    return `✅ 飞书文档已成功创建！\n\n📄 标题: ${title}\n🔗 链接: ${documentUrl}\n\n文档已包含抓取的内容，您可以直接查看和编辑。`;
  } catch (error) {
    console.error('[FeishuDoc] Error:', error);
    return `创建飞书文档时出错: ${error instanceof Error ? error.message : '未知错误'}`;
  }
}

/**
 * Call AI API to generate response
 * Supports DashScope (Aliyun) and Cloudflare AI Gateway
 */
async function callAI(
  env: AppEnv['Bindings'],
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  // Priority 1: Use Cloudflare Workers AI (fastest, no external API call)
  if (env.CF_AI_ACCOUNT_ID && env.CF_AI_API_TOKEN) {
    return await callCloudflareWorkersAI(
      env.CF_AI_ACCOUNT_ID,
      env.CF_AI_API_TOKEN,
      message,
      signal,
    );
  }

  // Priority 2: Cloudflare AI Gateway
  if (
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  ) {
    return await callCloudflareAIGateway(
      env.CLOUDFLARE_AI_GATEWAY_API_KEY,
      env.CF_AI_GATEWAY_ACCOUNT_ID,
      env.CF_AI_GATEWAY_GATEWAY_ID,
      env.CF_AI_GATEWAY_MODEL || '@cf/meta/llama-3.1-8b-instruct',
      message,
      signal,
    );
  }

  // Priority 3: DashScope (Aliyun)
  if (env.DASHSCOPE_API_KEY) {
    return await callDashScope(
      env.DASHSCOPE_API_KEY,
      env.DASHSCOPE_MODEL || 'qwen-plus',
      message,
      signal,
    );
  }

  // Priority 4: Anthropic
  if (env.ANTHROPIC_API_KEY) {
    return await callAnthropic(env.ANTHROPIC_API_KEY, message, signal);
  }

  // Priority 5: OpenAI
  if (env.OPENAI_API_KEY) {
    return await callOpenAI(env.OPENAI_API_KEY, message, signal);
  }

  return '抱歉，AI 服务未配置，无法处理您的消息。请在环境变量中配置 CF_AI_ACCOUNT_ID + CF_AI_API_TOKEN (推荐) 或其他 AI 服务。';
}

/**
 * Call Cloudflare Workers AI (direct, fastest)
 */
async function callCloudflareWorkersAI(
  accountId: string,
  apiToken: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Please respond in Chinese.' },
            { role: 'user', content: message },
          ],
          max_tokens: 2048,
        }),
        signal,
      },
    );

    if (!response.ok) {
      console.error('[AI] Cloudflare Workers AI error:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('[AI] Error details:', errorText);
      return '抱歉，AI 服务暂时不可用，请稍后再试。';
    }

    const data = (await response.json()) as {
      result?: { response?: string };
      success?: boolean;
      errors?: Array<{ message: string }>;
    };

    if (!data.success || data.errors) {
      console.error('[AI] Cloudflare Workers AI error:', data.errors);
      return '抱歉，AI 处理消息时出错了。';
    }

    return data.result?.response || '抱歉，AI 没有生成回复。';
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return '抱歉，AI 请求已取消。';
    }
    console.error('[AI] Cloudflare Workers AI exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Call DashScope (Aliyun) API
 */
async function callDashScope(
  apiKey: string,
  model: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: message },
          ],
          max_tokens: 2000,
        }),
        signal,
      },
    );

    if (!response.ok) {
      console.error('[AI] DashScope API error:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('[AI] DashScope error details:', errorText);
      return '抱歉，AI 服务暂时不可用，请稍后再试。';
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error) {
      console.error('[AI] DashScope error:', data.error);
      return '抱歉，AI 处理消息时出错了。';
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return '抱歉，AI 没有生成回复。';
    }

    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return '抱歉，AI 请求已超时。';
    }
    console.error('[AI] DashScope exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Call Cloudflare AI Gateway
 */
async function callCloudflareAIGateway(
  apiKey: string,
  accountId: string,
  gatewayId: string,
  model: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const slashIdx = model.indexOf('/');
    const provider = slashIdx > 0 ? model.substring(0, slashIdx) : 'workers-ai';
    const modelId = slashIdx > 0 ? model.substring(slashIdx + 1) : model;

    // Use Cloudflare AI Gateway with Workers AI for best performance
    const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}`;
    const isAnthropic = provider === 'anthropic';
    const isWorkersAI = provider === 'workers-ai';

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    let body: Record<string, unknown>;
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: modelId,
        messages: [{ role: 'user', content: message }],
        max_tokens: 2000,
      };
    } else if (isWorkersAI) {
      // Workers AI format
      body = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: message },
        ],
        max_tokens: 2048,
      };
    } else {
      body = {
        model: modelId,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: message },
        ],
        max_tokens: 2000,
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      console.error('[AI] Cloudflare AI Gateway error:', response.status, response.statusText);
      return '抱歉，AI 服务暂时不可用，请稍后再试。';
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ text?: string }>;
      result?: { response?: string };
      error?: { message?: string };
    };

    if (data.error) {
      console.error('[AI] Cloudflare AI Gateway error:', data.error);
      return '抱歉，AI 处理消息时出错了。';
    }

    // Handle Workers AI format
    if (data.result?.response) {
      return data.result.response;
    }

    // Handle Anthropic format (content array)
    if (data.content && Array.isArray(data.content)) {
      return data.content.map((c) => c.text || '').join('');
    }

    // Handle OpenAI format (choices)
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return '抱歉，AI 没有生成回复。';
    }

    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return '抱歉，AI 请求已超时。';
    }
    console.error('[AI] Cloudflare AI Gateway exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Call Anthropic API directly
 */
async function callAnthropic(
  apiKey: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: message }],
        max_tokens: 2000,
      }),
      signal,
    });

    if (!response.ok) {
      console.error('[AI] Anthropic API error:', response.status, response.statusText);
      return '抱歉，AI 服务暂时不可用，请稍后再试。';
    }

    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
      error?: { message?: string };
    };

    if (data.error) {
      console.error('[AI] Anthropic error:', data.error);
      return '抱歉，AI 处理消息时出错了。';
    }

    const content = data.content?.map((c) => c.text || '').join('');
    if (!content) {
      return '抱歉，AI 没有生成回复。';
    }

    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return '抱歉，AI 请求已超时。';
    }
    console.error('[AI] Anthropic exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Call OpenAI API directly
 */
async function callOpenAI(apiKey: string, message: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: message },
        ],
        max_tokens: 2000,
      }),
      signal,
    });

    if (!response.ok) {
      console.error('[AI] OpenAI API error:', response.status, response.statusText);
      return '抱歉，AI 服务暂时不可用，请稍后再试。';
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error) {
      console.error('[AI] OpenAI error:', data.error);
      return '抱歉，AI 处理消息时出错了。';
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return '抱歉，AI 没有生成回复。';
    }

    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return '抱歉，AI 请求已超时。';
    }
    console.error('[AI] OpenAI exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Process permission application event and grant manager permission to applicant
 * Event type: drive.file.permission_member_applied_v1
 */
async function processPermissionApplication(
  env: AppEnv['Bindings'],
  fileToken: string,
  fileType: string,
  applicantInfo: {
    member_type?: string;
    member_id?: string;
    open_id?: string;
    user_id?: string;
  }
): Promise<void> {
  try {
    console.log('[PermissionAutoGrant] Processing permission application', {
      fileToken,
      fileType,
      applicantInfo
    });

    const token = await getTenantAccessToken(env);
    if (!token) {
      console.error('[PermissionAutoGrant] Failed to get tenant access token');
      return;
    }

    // Extract applicant ID - prefer member_id if available
    const applicantId = applicantInfo.member_id || applicantInfo.open_id || applicantInfo.user_id;
    if (!applicantId) {
      console.error('[PermissionAutoGrant] No valid applicant ID found', applicantInfo);
      return;
    }

    // Determine member_type - use 'user' as default for human users
    // If member_type is explicitly provided, use it; otherwise infer from context
    const memberType = applicantInfo.member_type || 'user';

    // Build the permission API URL
    const permUrl = `https://open.feishu.cn/open-apis/drive/v1/permissions/${fileToken}/members?type=${fileType}`;

    // Grant manager permission
    const response = await fetch(permUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        members: [
          {
            member_type: memberType,
            member_id: applicantId,
            perm: 'manager' // Grant manager permission
          }
        ]
      }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log('[PermissionAutoGrant] Successfully granted manager permission', {
        fileToken,
        applicantId,
        memberType,
        result
      });
    } else {
      const errorData = await response.json().catch(() => null);
      console.error('[PermissionAutoGrant] Failed to grant manager permission', {
        fileToken,
        applicantId,
        status: response.status,
        error: errorData
      });
    }
  } catch (error) {
    console.error('[PermissionAutoGrant] Error processing permission application:', error);
  }
}
