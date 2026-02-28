import { Hono } from 'hono';
import * as lark from '@larksuiteoapi/node-sdk';
import type { AppEnv, MoltbotEnv } from '../types';

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
      'im.message.receive_v1': async (eventData) => {
         const message = eventData.message;
         if (message.message_type === 'text') {
           const contentObj = JSON.parse(message.content);
           const text = contentObj.text || '';
           if (text.includes('整理 PDF') || text.includes('分析合同')) {
             // Kick off background task to process PDF without blocking the 3-second webhook timeout
             c.executionCtx.waitUntil(processPdfAndReply(c.env, message).catch(console.error));
           }
         }
         return {};
      }
    });

    // Invoke the dispatcher to handle Feishu's internal logic (including URL verification challenge)
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

/**
 * Background task to process the latest PDF and reply via Feishu
 */
async function processPdfAndReply(env: MoltbotEnv, message: any) {
  const client = new lark.Client({ appId: env.FEISHU_APP_ID!, appSecret: env.FEISHU_APP_SECRET! });
  
  try {
    // 1. Send processing message
    await client.im.v1.message.reply({
      path: { message_id: message.message_id },
      data: { content: JSON.stringify({ text: '⏳ 收到请求，正在从 R2 获取最新 PDF 并分析，请稍候...' }), msg_type: 'text' }
    });

    // 2. Get latest PDF from R2
    const listed = await env.MOLTBOT_BUCKET.list();
    const pdfs = listed.objects.filter((o: any) => o.key.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) {
      await client.im.v1.message.reply({
        path: { message_id: message.message_id },
        data: { content: JSON.stringify({ text: '❌ 在 R2 存储桶 (moltbot-data) 中没有找到任何 PDF 文件。' }), msg_type: 'text' }
      });
      return;
    }
    
    // Sort by uploaded time descending to get the latest
    pdfs.sort((a: any, b: any) => b.uploaded.getTime() - a.uploaded.getTime());
    const latestPdf = pdfs[0];
    
    const pdfObj = await env.MOLTBOT_BUCKET.get(latestPdf.key);
    if (!pdfObj) throw new Error('Failed to read PDF from R2');
    const pdfBuffer = await pdfObj.arrayBuffer();

    // 3. Upload to DashScope
    if (!env.DASHSCOPE_API_KEY) {
      throw new Error('DASHSCOPE_API_KEY 未配置');
    }

    const formData = new FormData();
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('file', blob, latestPdf.key);
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
      throw new Error(`DashScope upload failed: ${errText}`);
    }
    
    const uploadData = await uploadRes.json() as any;
    if (!uploadData.id) throw new Error('DashScope upload failed, no file ID returned.');
    const fileId = uploadData.id;

    // 4. Summarize with LLM (Qwen-long supports document understanding via fileId)
    const llmRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-long',
        messages: [
          { role: 'system', content: '你是一个专业的法律文件处理助手。请分析提供的文件并给出准确、专业的摘要和关键点提取，使用Markdown格式输出。' },
          { role: 'user', content: `system://${fileId}\n请提取这份文档（${latestPdf.key}）的关键信息，并生成一份简明扼要的摘要。` }
        ]
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
    const docRes = await client.docx.v1.document.create({
      data: {
        title: `📄 摘要: ${latestPdf.key}`,
      }
    });
    
    const documentId = docRes.data?.document?.document_id;
    if (!documentId) throw new Error('Failed to create Feishu doc: ' + JSON.stringify(docRes));
    
    // Write summary to the doc
    await client.docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
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
      }
    });

    // 6. Reply success
    const docUrl = `https://feishu.cn/docx/${documentId}`;
    await client.im.v1.message.reply({
      path: { message_id: message.message_id },
      data: { 
        content: JSON.stringify({ text: `✅ 处理成功！\n\n📁 文件：${latestPdf.key}\n📄 摘要文档：${docUrl}` }), 
        msg_type: 'text' 
      }
    });

  } catch (err) {
    console.error('Error processing PDF:', err);
    await client.im.v1.message.reply({
      path: { message_id: message.message_id },
      data: { content: JSON.stringify({ text: `❌ 处理失败：${err instanceof Error ? err.message : String(err)}` }), msg_type: 'text' }
    });
  }
}
