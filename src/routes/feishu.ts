import { Hono } from 'hono';
import type { AppEnv } from '../types';

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
