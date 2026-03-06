---
name: feishu
description: Complete Feishu (Lark) integration for messaging, bots, and workspace automation. Send messages, manage groups, and handle webhooks.
---

# Feishu Skill

Complete Feishu (Lark) integration for messaging and workspace automation.

## Features

- Send text messages to users and groups
- Handle incoming webhooks
- Upload images and files
- Create and manage groups
- Bot authentication

## Environment Variables

```bash
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxx  # Optional, for encryption
```

## Usage Examples

### Get Tenant Access Token

```bash
curl -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d "{
    \"app_id\": \"${FEISHU_APP_ID}\",
    \"app_secret\": \"${FEISHU_APP_SECRET}\"
  }"
```

### Send Message to User

```bash
TOKEN=$(get_tenant_token)
curl -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "receive_id": "ou_xxxxxxxx",
    "msg_type": "text",
    "content": "{\"text\":\"Hello from OpenClaw!\"}"
  }'
```

### Send Rich Text (Post)

```bash
curl -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "receive_id": "ou_xxxxxxxx",
    "msg_type": "post",
    "content": "{\"zh_cn\":{\"title\":\"Update\",\"content\":[[{\"tag\":\"text\",\"text\":\"New version released!\"}]]}}"
  }'
```

### Send Interactive Card

```bash
curl -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "receive_id": "oc_xxxxxxxx",
    "msg_type": "interactive",
    "card": {
      "config": {"wide_screen_mode": true},
      "header": {"title": {"content": "Notification"}},
      "elements": [{"tag": "div", "text": {"content": "Task completed!"}}]
    }
  }'
```

### Upload Image

```bash
# First upload the image
RESPONSE=$(curl -X POST "https://open.feishu.cn/open-apis/im/v1/images" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "image_type=message" \
  -F "image=@screenshot.png")

# Extract image_key and send
IMAGE_KEY=$(echo $RESPONSE | jq -r '.data.image_key')

curl -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"receive_id\": \"ou_xxxxxxxx\",
    \"msg_type\": \"image\",
    \"content\": \"{\\\"image_key\\\": \\\"${IMAGE_KEY}\\\"}\"
  }"
```

## Message Types

- `text` - Plain text
- `post` - Rich text with formatting
- `image` - Image messages
- `file` - File attachments
- `interactive` - Interactive cards
- `share_chat` - Group share cards
- `share_user` - User share cards

## Webhook Verification

```javascript
// Verify webhook signature
function verifyWebhook(body, signature, timestamp, verificationToken) {
  const crypto = require('crypto');
  const sign = crypto.createHmac('sha256', verificationToken)
    .update(timestamp + '\n' + body)
    .digest('hex');
  return sign === signature;
}
```

## Documentation

- [Feishu Open Platform](https://open.feishu.cn/)
- [API Reference](https://open.feishu.cn/document/server-docs/getting-started/server-overview)
