---
name: cf-ai
description: Direct integration with Cloudflare Workers AI for fast, local AI inference. Supports text generation, embeddings, and image generation using Cloudflare's edge AI models.
---

# Cloudflare Workers AI Skill

Direct integration with Cloudflare Workers AI for fast AI inference at the edge.

## Features

- Text generation using Llama, Mistral, Qwen models
- Embeddings generation
- Image generation (Stable Diffusion)
- Translation and summarization
- No external API calls needed - runs on Cloudflare's edge

## Environment Variables

```bash
CF_AI_ACCOUNT_ID=your_cloudflare_account_id
CF_AI_API_TOKEN=your_cloudflare_api_token_with_ai_permissions
```

## Usage Examples

### Text Generation

```javascript
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF_AI_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_AI_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Explain quantum computing' },
      ],
      max_tokens: 2048,
    }),
  }
);
```

### Embeddings

```javascript
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF_AI_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_AI_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: 'Hello world' }),
  }
);
```

### Image Generation

```javascript
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF_AI_ACCOUNT_ID}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_AI_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt: 'A cyberpunk cat' }),
  }
);
```

## Available Models

| Model | Type | Description |
|-------|------|-------------|
| `@cf/meta/llama-3.1-8b-instruct` | Text | General instruction following |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Text | Large model, more capable |
| `@cf/mistral/mistral-7b-instruct-v0.2` | Text | Fast, efficient |
| `@cf/qwen/qwen1.5-14b-chat-awq` | Text | Multilingual support |
| `@cf/baai/bge-base-en-v1.5` | Embedding | Text embeddings |
| `@cf/stabilityai/stable-diffusion-xl-base-1.0` | Image | Image generation |
| `@cf/openai/whisper` | Audio | Speech-to-text |

## Rate Limits

- Free tier: 10,000 requests per day
- Paid tier: Higher limits based on plan

## Documentation

- [Cloudflare AI Docs](https://developers.cloudflare.com/workers-ai/)
- [Model Catalog](https://developers.cloudflare.com/workers-ai/models/)
