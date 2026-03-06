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
 * Handle a Feishu message: call OpenClaw AI and send the response back
 */
async function handleFeishuMessage(
  env: AppEnv['Bindings'],
  sandbox: import('@cloudflare/sandbox').Sandbox,
  userOpenId: string,
  userMessage: string,
): Promise<void> {
  try {
    // Ensure the OpenClaw gateway is running
    await ensureMoltbotGateway(sandbox, env);

    // Call OpenClaw's gateway to process the message
    const gatewayUrl = `http://localhost:${MOLTBOT_PORT}/v1/chat`;

    const response = await sandbox.containerFetch(
      new Request(gatewayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: userMessage,
          channel: 'feishu',
          user_id: userOpenId,
        }),
      }),
      MOLTBOT_PORT,
    );

    if (!response.ok) {
      console.error('[Feishu] OpenClay gateway error:', response.status, response.statusText);
      await sendFeishuMessage(env, userOpenId, '抱歉，我暂时无法处理您的消息，请稍后再试。');
      return;
    }

    const data = (await response.json()) as { response?: string; error?: string };

    if (data.error) {
      console.error('[Feishu] OpenClaw returned error:', data.error);
      await sendFeishuMessage(env, userOpenId, '抱歉，处理消息时出错了，请稍后再试。');
      return;
    }

    const aiResponse = data.response || '抱歉，我没有生成回复。';

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
