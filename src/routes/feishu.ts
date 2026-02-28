import { Hono } from 'hono';
import type { AppEnv } from '../types';

/**
 * Feishu Webhook routes
 */
export const feishu = new Hono<AppEnv>();

feishu.post('/webhook', async (c) => {
  try {
    const body = await c.req.json();

    // 1. URL Verification (Challenge)
    if (body.type === 'url_verification') {
      if (c.env.FEISHU_VERIFICATION_TOKEN && body.token !== c.env.FEISHU_VERIFICATION_TOKEN) {
        console.error('[Feishu] Invalid verification token');
        return c.json({ error: 'Invalid token' }, 403);
      }
      console.log('[Feishu] URL verification successful');
      return c.json({ challenge: body.challenge });
    }

    // 2. Handle Message events (placeholder for Task 2)
    // We will return 200 OK for now to avoid Feishu retrying
    return c.json({ ok: true });
  } catch (error) {
    console.error('[Feishu] Webhook processing error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
