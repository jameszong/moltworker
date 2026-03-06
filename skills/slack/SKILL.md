---
name: slack
description: Slack integration for sending messages, managing channels, and automating workspace notifications. Supports both bot tokens and user tokens.
---

# Slack Skill

Slack API integration for messaging and workspace automation.

## Features

- Send messages to channels and DMs
- Upload files
- Create and manage channels
- React to messages
- Schedule messages
- Thread replies

## Environment Variables

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token  # For Socket Mode
SLACK_SIGNING_SECRET=your-signing-secret  # For webhook verification
```

## Usage Examples

### Send Message to Channel

```bash
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "#general",
    "text": "Hello from OpenClaw!"
  }'
```

### Send Direct Message

```bash
curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "U1234567890",
    "text": "Private message here"
  }'
```

### Upload File

```bash
curl -F file=@report.pdf \
  -F "channels=#general" \
  -F "initial_comment=Here is the report" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  https://slack.com/api/files.upload
```

### Create Channel

```bash
curl -X POST https://slack.com/api/conversations.create \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "new-project-channel",
    "is_private": false
  }'
```

### React to Message

```bash
curl -X POST https://slack.com/api/reactions.add \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C1234567890",
    "timestamp": "1234567890.123456",
    "name": "thumbsup"
  }'
```

## Bot Token Scopes Required

- `chat:write` - Send messages
- `files:write` - Upload files
- `channels:read` - List channels
- `channels:manage` - Create channels
- `groups:write` - Manage private channels
- `im:write` - Send DMs
- `reactions:write` - Add reactions

## Rate Limits

- Tier 1: 1+ per minute
- Tier 2: 20+ per minute
- Tier 3: 50+ per minute
- Tier 4: 100+ per minute

## Documentation

- [Slack API Docs](https://api.slack.com/)
- [Bot Permissions](https://api.slack.com/scopes)
