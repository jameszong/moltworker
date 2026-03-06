import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ensureMoltbotGateway } from '../gateway';
import { sendFeishuMessage } from '../services/feishu-api';
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
      const processingPromise = handleFeishuMessageWithTimeout(c.env, openId || unionId || '', textContent, 55000);
      c.executionCtx.waitUntil(processingPromise);

      return c.body(null, 200);
    }

    // For other event types, fall through to proxy to container
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
    await Promise.race([
      handleFeishuMessage(env, userOpenId, userMessage),
      timeoutPromise,
    ]);
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
 */
async function handleFeishuMessage(
  env: AppEnv['Bindings'],
  userOpenId: string,
  userMessage: string,
): Promise<void> {
  try {
    // Build conversation with tool support
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: '你是一个 helpful assistant。如果需要获取网页内容来获取信息，请使用 web_scrape 工具。' },
      { role: 'user', content: userMessage },
    ];

    // Call AI with tool support (up to 3 tool call rounds)
    let finalResponse = '';
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
            
            // Add tool result to conversation
            messages.push(
              { role: 'assistant', content: `我将抓取网页: ${args.url}` },
              { role: 'user', content: `[网页抓取结果]\n${scrapeResult}` },
            );
          }
        }
      }
    }

    if (!finalResponse) {
      finalResponse = '抱歉，处理您的请求时出现了问题。';
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
  timeoutMs: number
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
    return await callDashScopeWithTools(env.DASHSCOPE_API_KEY, env.DASHSCOPE_MODEL || 'qwen-plus', messages, tools, signal);
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
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        tools: tools,
        max_tokens: 2000,
      }),
      signal,
    });

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

  try {
    console.log(`[WebScrape] Starting to scrape: ${url}`);
    
    // Launch browser using puppeteer
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    
    // Navigate to URL with timeout
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
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
        'body'
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
    
    await browser.close();
    
    const result = `标题: ${title}\n\n内容:\n${content}`;
    console.log(`[WebScrape] Successfully scraped ${url}, content length: ${content.length}`);
    
    return result;
  } catch (error) {
    console.error('[WebScrape] Error:', error);
    return `抓取网页时出错: ${error instanceof Error ? error.message : '未知错误'}`;
  }
}

/**
 * Call AI API to generate response
 * Supports DashScope (Aliyun) and Cloudflare AI Gateway
 */
async function callAI(env: AppEnv['Bindings'], message: string, signal?: AbortSignal): Promise<string> {
  // Priority 1: Use Cloudflare Workers AI (fastest, no external API call)
  if (env.CF_AI_ACCOUNT_ID && env.CF_AI_API_TOKEN) {
    return await callCloudflareWorkersAI(env.CF_AI_ACCOUNT_ID, env.CF_AI_API_TOKEN, message, signal);
  }

  // Priority 2: Cloudflare AI Gateway
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY && env.CF_AI_GATEWAY_ACCOUNT_ID && env.CF_AI_GATEWAY_GATEWAY_ID) {
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
    return await callDashScope(env.DASHSCOPE_API_KEY, env.DASHSCOPE_MODEL || 'qwen-plus', message, signal);
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
          'Authorization': `Bearer ${apiToken}`,
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
async function callDashScope(apiKey: string, model: string, message: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
    });

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
      'Authorization': `Bearer ${apiKey}`,
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
async function callAnthropic(apiKey: string, message: string, signal?: AbortSignal): Promise<string> {
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
        'Authorization': `Bearer ${apiKey}`,
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
