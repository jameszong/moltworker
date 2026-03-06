import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ensureMoltbotGateway } from '../gateway';
import { sendFeishuMessage } from '../services/feishu-api';
import { MOLTBOT_PORT } from '../config';

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
      c.executionCtx.waitUntil(
        handleFeishuMessage(c.env, sandbox, openId || unionId || '', textContent),
      );

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
 * Handle a Feishu message: call AI directly and send the response back
 */
async function handleFeishuMessage(
  env: AppEnv['Bindings'],
  sandbox: import('@cloudflare/sandbox').Sandbox,
  userOpenId: string,
  userMessage: string,
): Promise<void> {
  try {
    // Call AI directly using DashScope (Aliyun) API
    const aiResponse = await callAI(env, userMessage);

    // Send the AI response back to the user
    const sent = await sendFeishuMessage(env, userOpenId, aiResponse);
    if (!sent) {
      console.error('[Feishu] Failed to send AI response to user:', userOpenId);
    } else {
      console.log('[Feishu] AI response sent successfully to user:', userOpenId);
    }
  } catch (error) {
    console.error('[Feishu] Error handling message:', error);
    // Try to send an error message to the user
    try {
      await sendFeishuMessage(env, userOpenId, '抱歉，系统遇到了问题，请稍后再试。');
    } catch (sendError) {
      console.error('[Feishu] Failed to send error message:', sendError);
    }
  }
}

/**
 * Call AI API to generate response
 * Supports DashScope (Aliyun) and Cloudflare AI Gateway
 */
async function callAI(env: AppEnv['Bindings'], message: string): Promise<string> {
  // Try DashScope first (Aliyun)
  if (env.DASHSCOPE_API_KEY) {
    return await callDashScope(env.DASHSCOPE_API_KEY, env.DASHSCOPE_MODEL || 'qwen-plus', message);
  }

  // Fallback to Cloudflare AI Gateway if configured
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY && env.CF_AI_GATEWAY_ACCOUNT_ID && env.CF_AI_GATEWAY_GATEWAY_ID) {
    return await callCloudflareAIGateway(
      env.CLOUDFLARE_AI_GATEWAY_API_KEY,
      env.CF_AI_GATEWAY_ACCOUNT_ID,
      env.CF_AI_GATEWAY_GATEWAY_ID,
      env.CF_AI_GATEWAY_MODEL || 'openai/gpt-4o',
      message,
    );
  }

  // Try Anthropic if configured
  if (env.ANTHROPIC_API_KEY) {
    return await callAnthropic(env.ANTHROPIC_API_KEY, message);
  }

  // Try OpenAI if configured
  if (env.OPENAI_API_KEY) {
    return await callOpenAI(env.OPENAI_API_KEY, message);
  }

  return '抱歉，AI 服务未配置，无法处理您的消息。';
}

/**
 * Call DashScope (Aliyun) API
 */
async function callDashScope(apiKey: string, model: string, message: string): Promise<string> {
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
): Promise<string> {
  try {
    const slashIdx = model.indexOf('/');
    const provider = slashIdx > 0 ? model.substring(0, slashIdx) : 'openai';
    const modelId = slashIdx > 0 ? model.substring(slashIdx + 1) : model;

    const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}`;
    const isAnthropic = provider === 'anthropic';

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
    });

    if (!response.ok) {
      console.error('[AI] Cloudflare AI Gateway error:', response.status, response.statusText);
      return '抱歉，AI 服务暂时不可用，请稍后再试。';
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ text?: string }>;
      error?: { message?: string };
    };

    if (data.error) {
      console.error('[AI] Cloudflare AI Gateway error:', data.error);
      return '抱歉，AI 处理消息时出错了。';
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
    console.error('[AI] Cloudflare AI Gateway exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Call Anthropic API directly
 */
async function callAnthropic(apiKey: string, message: string): Promise<string> {
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
    console.error('[AI] Anthropic exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}

/**
 * Call OpenAI API directly
 */
async function callOpenAI(apiKey: string, message: string): Promise<string> {
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
    console.error('[AI] OpenAI exception:', error);
    return '抱歉，调用 AI 服务时发生错误。';
  }
}
