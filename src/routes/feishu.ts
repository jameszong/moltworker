import { Hono } from 'hono';
import * as lark from '@larksuiteoapi/node-sdk';
import type { AppEnv } from '../types';

/**
 * Feishu Webhook routes
 */
export const feishu = new Hono<AppEnv>();

feishu.post('/webhook', async (c) => {
  try {
    // Read the raw body text and parse it
    const bodyText = await c.req.text();
    const data = JSON.parse(bodyText);
    
    // Set up the event dispatcher with credentials from environment variables
    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: '', // No encrypt key used currently
      verificationToken: c.env.FEISHU_VERIFICATION_TOKEN || '',
    }).register({
      // We will handle specific events here later in Task 2
      // 'im.message.receive_v1': async (data) => { ... }
    });

    // Invoke the dispatcher to handle Feishu's internal logic (including URL verification challenge)
    // For URL verification, the SDK will validate the token and return { challenge: "..." }
    const result = await eventDispatcher.invoke(data);
    
    // If the SDK returns an object with a challenge, return it back to Feishu
    if (result && result.challenge) {
      console.log('[Feishu SDK] Challenge successful');
      return c.json(result);
    }

    // Default success response
    return c.json({ ok: true });
  } catch (error) {
    console.error('[Feishu SDK] Webhook processing error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});
