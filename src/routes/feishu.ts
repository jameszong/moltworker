import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ensureMoltbotGateway } from '../gateway';

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

    // Intercept Feishu url_verification challenge at the edge
    // This avoids needing to wake up the container or deal with Lark SDK routing quirks
    try {
      // Clone the request so we can read the body without consuming the stream
      // if we end up needing to proxy it later
      const reqClone = c.req.raw.clone();
      
      // Check content type to ensure it's JSON before parsing
      const contentType = reqClone.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const body = await reqClone.json();
        if (body && typeof body === 'object' && body.type === 'url_verification' && body.challenge) {
          console.log('[Feishu] Intercepted url_verification challenge at the edge');
          return c.json({ challenge: body.challenge });
        }
      }
    } catch (e) {
      // Ignore JSON parse errors, just fall through to proxy
      console.log('[Feishu] Failed to parse request body for url_verification check, falling through to proxy', e);
    }

    // Ensure the container is awake and the OpenClaw process (including Feishu on port 3000) is ready
    await ensureMoltbotGateway(sandbox, c.env);

    // Rewrite the URL to match the path expected by the OpenClaw Feishu adapter
    const originalUrl = new URL(c.req.url);
    const containerUrl = new URL(originalUrl.toString());
    containerUrl.pathname = '/webhooks/feishu';

    const containerReq = new Request(containerUrl.toString(), c.req.raw);

    console.log('[Feishu] Proxying webhook to container port 3000...');
    
    // Forward the request to the Feishu plugin's webhook server on port 3000
    const containerRes = await sandbox.containerFetch(containerReq, 3000);
    
    // Return the response from OpenClaw (handles both url_verification and normal messages)
    return containerRes;
  } catch (error) {
    console.error('[Feishu] Webhook proxy error:', error);
    return c.json({ error: 'Internal server error during proxying' }, 500);
  }
});
