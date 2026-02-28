import { Hono } from 'hono';
import type { AppEnv, MoltbotEnv } from '../types';

/**
 * Feishu Webhook routes
 */
export const feishu = new Hono<AppEnv>();

feishu.post('/webhook', async (c) => {
  try {
    const bodyText = await c.req.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // 1. Handle URL Verification (Challenge)
    if (data.type === 'url_verification') {
      if (c.env.FEISHU_VERIFICATION_TOKEN && data.token !== c.env.FEISHU_VERIFICATION_TOKEN) {
        console.error('[Feishu] Invalid verification token');
        return c.json({ error: 'Invalid token' }, 403);
      }
      console.log('[Feishu] URL verification successful');
      return c.json({ challenge: data.challenge });
    }

    // 2. Handle Event v2 (e.g. im.message.receive_v1)
    if (data.schema === '2.0' && data.header?.event_type === 'im.message.receive_v1') {
      const eventToken = data.header.token;
      if (c.env.FEISHU_VERIFICATION_TOKEN && eventToken !== c.env.FEISHU_VERIFICATION_TOKEN) {
        console.error('[Feishu] Invalid event verification token');
        return c.json({ error: 'Invalid token' }, 403);
      }

      const message = data.event.message;
      if (message.message_type === 'text') {
        let contentObj;
        try {
          contentObj = JSON.parse(message.content);
        } catch {
          contentObj = {};
        }
        
        const text = contentObj.text || '';
        if (text.includes('整理 PDF') || text.includes('分析合同')) {
          // Kick off background task to process PDF without blocking the 3-second webhook timeout
          c.executionCtx.waitUntil(processPdfAndReply(c.env, message).catch(console.error));
        }
      } else if (message.message_type === 'file') {
        let contentObj;
        try {
          contentObj = JSON.parse(message.content);
        } catch {
          contentObj = {};
        }
        
        const fileName = contentObj.file_name || 'unknown.pdf';
        const fileKey = contentObj.file_key;
        if (fileKey && fileName.toLowerCase().endsWith('.pdf')) {
          c.executionCtx.waitUntil(downloadAndSaveFeishuFile(c.env, message.message_id, fileKey, fileName, message.chat_id).catch(console.error));
        }
      }
    }

    // Default success response for all other events to avoid retries
    return c.json({ ok: true });
  } catch (error) {
    console.error('[Feishu] Webhook processing error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Get Feishu Tenant Access Token
 */
async function getFeishuToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json() as any;
  if (data.code !== 0) {
    throw new Error(`Failed to get Feishu token: ${data.msg}`);
  }
  return data.tenant_access_token;
}

/**
 * Reply to a Feishu message
 */
async function replyFeishuMessage(token: string, messageId: string, content: string, msgType: string = 'text') {
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: JSON.stringify({ text: content }),
      msg_type: msgType
    })
  });
  const data = await res.json() as any;
  if (data.code !== 0) {
    console.error('Failed to reply Feishu message:', data);
  }
}

/**
 * Download file from Feishu and save to R2
 */
async function downloadAndSaveFeishuFile(env: MoltbotEnv, messageId: string, fileKey: string, fileName: string, chatId: string) {
  try {
    const feishuToken = await getFeishuToken(env.FEISHU_APP_ID!, env.FEISHU_APP_SECRET!);
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, {
      headers: { 'Authorization': `Bearer ${feishuToken}` }
    });
    
    if (!res.ok) {
      console.error(`Failed to download file from Feishu: ${res.status} ${res.statusText}`);
      await replyFeishuMessage(feishuToken, messageId, `❌ 下载文件失败。`);
      return;
    }
    
    const arrayBuffer = await res.arrayBuffer();
    const objectKey = `chat_data/${chatId}/${Date.now()}_${fileName}`;
    await env.MOLTBOT_BUCKET.put(objectKey, arrayBuffer);
    
    await replyFeishuMessage(feishuToken, messageId, `✅ 文件 ${fileName} 已接收并暂存。\n请在上传完所有需处理的文件后，回复“整理 PDF”开始分析。`);
  } catch (err) {
    console.error('Error in downloadAndSaveFeishuFile:', err);
  }
}

/**
 * Background task to process the latest PDF and reply via Feishu
 */
async function processPdfAndReply(env: MoltbotEnv, message: any) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    console.error('Feishu App ID or Secret is not configured');
    return;
  }

  let feishuToken: string;
  try {
    feishuToken = await getFeishuToken(env.FEISHU_APP_ID, env.FEISHU_APP_SECRET);
  } catch (err) {
    console.error(err);
    return;
  }
  
  try {
    // 1. Send processing message
    await replyFeishuMessage(feishuToken, message.message_id, '⏳ 收到请求，正在提取当前对话中暂存的 PDF 并分析，请稍候...');

    // 2. Get PDFs for this chat from R2
    const prefix = `chat_data/${message.chat_id}/`;
    const listed = await env.MOLTBOT_BUCKET.list({ prefix });
    const pdfs = listed.objects.filter((o: any) => o.key.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) {
      await replyFeishuMessage(feishuToken, message.message_id, '❌ 在当前对话中没有找到任何待处理的 PDF 文件。请先直接向我发送 PDF 文件。');
      return;
    }

    // Sort by uploaded time to process in order
    pdfs.sort((a: any, b: any) => a.uploaded.getTime() - b.uploaded.getTime());

    // 3. Upload to DashScope
    if (!env.DASHSCOPE_API_KEY) {
      throw new Error('DASHSCOPE_API_KEY 未配置');
    }

    const fileIds: string[] = [];
    const fileNames: string[] = [];

    for (const pdf of pdfs) {
      const pdfObj = await env.MOLTBOT_BUCKET.get(pdf.key);
      if (!pdfObj) continue;
      const pdfBuffer = await pdfObj.arrayBuffer();

      const fileName = pdf.key.split('_').slice(1).join('_') || 'file.pdf'; // remove timestamp
      fileNames.push(fileName);

      const formData = new FormData();
      const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
      formData.append('file', blob, fileName);
      formData.append('purpose', 'file-extract');

      const uploadRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.DASHSCOPE_API_KEY}`
        },
        body: formData
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`DashScope upload failed for ${fileName}: ${errText}`);
      }

      const uploadData = await uploadRes.json() as any;
      if (!uploadData.id) throw new Error(`DashScope upload failed, no file ID returned for ${fileName}`);
      fileIds.push(uploadData.id);
    }

    // 4. Summarize with LLM (Qwen-long supports document understanding via fileId)
    const messages: any[] = [
      { role: 'system', content: '你是一个专业的法律文件处理助手。请分析提供的文件并给出准确、专业的摘要和关键点提取，使用Markdown格式输出。' }
    ];

    for (const id of fileIds) {
      messages.push({ role: 'system', content: `fileid://${id}` });
    }

    messages.push({ role: 'user', content: '请提取上述文件的关键信息，并生成一份简明扼要的摘要。如果有多个文件，请分别指出它们的核心内容，或综合给出分析。' });

    const llmRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-long',
        messages: messages
      })
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      throw new Error(`LLM generation failed: ${errText}`);
    }

    const llmData = await llmRes.json() as any;
    const summary = llmData.choices?.[0]?.message?.content || '未能生成摘要。';

    // 5. Create Feishu Doc
    // Create a new Docx
    const docRes = await fetch('https://open.feishu.cn/open-apis/docx/v1/documents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${feishuToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: `📄 分析报告: ${fileNames.join(', ').substring(0, 50)}${fileNames.join(', ').length > 50 ? '...' : ''}`
      })
    });
    
    const docData = await docRes.json() as any;
    if (docData.code !== 0) throw new Error(`Failed to create Feishu doc: ${JSON.stringify(docData)}`);
    
    const documentId = docData.data?.document?.document_id;
    if (!documentId) throw new Error('Failed to get document_id from creation response');

    // Write summary to the doc
    const writeRes = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${feishuToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        children: [
          {
            block_type: 2, // Text block
            text: {
              elements: [
                { text_run: { content: summary } }
              ]
            }
          }
        ],
        index: -1
      })
    });
    
    const writeData = await writeRes.json() as any;
    if (writeData.code !== 0) {
      console.error('Failed to write to Feishu doc:', writeData);
      // We don't fail completely here, we can still link the empty/partially complete doc
    }

    // 6. Delete processed files from R2
    for (const pdf of pdfs) {
      await env.MOLTBOT_BUCKET.delete(pdf.key);
    }

    // 7. Reply success
    const docUrl = `https://feishu.cn/docx/${documentId}`;
    await replyFeishuMessage(feishuToken, message.message_id, `✅ 处理成功！\n\n📁 已处理文件：${fileNames.length} 份\n📄 分析报告：${docUrl}`);

  } catch (err) {
    console.error('Error processing PDF:', err);
    await replyFeishuMessage(feishuToken, message.message_id, `❌ 处理失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
