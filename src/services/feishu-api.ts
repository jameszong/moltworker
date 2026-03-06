import type { MoltbotEnv } from '../types';

interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuMessageResponse {
  code: number;
  msg: string;
  data?: {
    message_id: string;
  };
}

// Cache for tenant access token
let cachedToken: string | null = null;
let tokenExpireTime = 0;

/**
 * Get Feishu tenant access token
 * Uses FEISHU_APP_ID and FEISHU_APP_SECRET from environment
 */
export async function getTenantAccessToken(env: MoltbotEnv): Promise<string | null> {
  const now = Date.now();

  // Return cached token if still valid (with 5 minute buffer)
  if (cachedToken && tokenExpireTime > now + 5 * 60 * 1000) {
    return cachedToken;
  }

  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    console.error('[Feishu] Missing FEISHU_APP_ID or FEISHU_APP_SECRET');
    return null;
  }

  try {
    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
    });

    if (!response.ok) {
      console.error('[Feishu] Failed to get tenant access token:', response.status, response.statusText);
      return null;
    }

    const data = (await response.json()) as FeishuTokenResponse;

    if (data.code !== 0) {
      console.error('[Feishu] Error getting tenant access token:', data.msg);
      return null;
    }

    if (data.tenant_access_token) {
      cachedToken = data.tenant_access_token;
      // expire is in seconds, convert to milliseconds
      tokenExpireTime = now + (data.expire || 7200) * 1000;
      return cachedToken;
    }

    return null;
  } catch (error) {
    console.error('[Feishu] Exception getting tenant access token:', error);
    return null;
  }
}

/**
 * Send a text message to a Feishu user
 *
 * @param env - Environment bindings
 * @param openId - The user's open_id
 * @param text - The message text to send
 * @returns true if message was sent successfully
 */
export async function sendFeishuMessage(env: MoltbotEnv, openId: string, text: string): Promise<boolean> {
  const token = await getTenantAccessToken(env);
  if (!token) {
    console.error('[Feishu] Cannot send message: no valid token');
    return false;
  }

  try {
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({
          text: text,
        }),
      }),
    });

    if (!response.ok) {
      console.error('[Feishu] Failed to send message:', response.status, response.statusText);
      return false;
    }

    const data = (await response.json()) as FeishuMessageResponse;

    if (data.code !== 0) {
      console.error('[Feishu] Error sending message:', data.msg);
      return false;
    }

    console.log('[Feishu] Message sent successfully, message_id:', data.data?.message_id);
    return true;
  } catch (error) {
    console.error('[Feishu] Exception sending message:', error);
    return false;
  }
}
