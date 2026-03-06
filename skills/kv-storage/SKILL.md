---
name: kv-storage
description: Cloudflare KV (Key-Value) storage operations for persistent data storage. Store configuration, session data, and cached content with global edge replication.
---

# Cloudflare KV Storage Skill

Cloudflare KV storage operations for persistent key-value data at the edge.

## Features

- Global edge replication
- Read-heavy workloads optimized
- Automatic caching
- TTL support for expiration
- Bulk operations
- List keys with prefix

## Environment Variables

```bash
# KV namespace binding name (configure in wrangler.toml)
KV_NAMESPACE=MY_KV
```

## Usage Examples

### wrangler.toml Configuration

```toml
[[kv_namespaces]]
binding = "MY_KV"
id = "your_kv_namespace_id"
preview_id = "your_preview_kv_namespace_id"
```

### Store Value

```javascript
await env.MY_KV.put('user:123', JSON.stringify({ name: 'John', role: 'admin' }));
```

### Store with TTL

```javascript
// Expires in 1 hour
await env.MY_KV.put('session:abc', sessionData, { expirationTtl: 3600 });
```

### Retrieve Value

```javascript
const value = await env.MY_KV.get('user:123');
const user = JSON.parse(value);
```

### List Keys

```javascript
const list = await env.MY_KV.list({ prefix: 'user:' });
for (const key of list.keys) {
  console.log(key.name, key.expiration);
}
```

### Delete Value

```javascript
await env.MY_KV.delete('user:123');
```

### Bulk Operations

```javascript
// Put multiple values
await env.MY_KV.put('key1', 'value1');
await env.MY_KV.put('key2', 'value2');
await env.MY_KV.put('key3', 'value3');

// Delete multiple
await Promise.all(['key1', 'key2', 'key3'].map(k => env.MY_KV.delete(k)));
```

## Common Use Cases

### Session Store

```javascript
async function getSession(sessionId) {
  const data = await env.MY_KV.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

async function setSession(sessionId, data, ttl = 86400) {
  await env.MY_KV.put(`session:${sessionId}`, JSON.stringify(data), {
    expirationTtl: ttl
  });
}
```

### Configuration Store

```javascript
async function getConfig(key, defaultValue = null) {
  const value = await env.MY_KV.get(`config:${key}`);
  return value !== null ? JSON.parse(value) : defaultValue;
}

async function setConfig(key, value) {
  await env.MY_KV.put(`config:${key}`, JSON.stringify(value));
}
```

### Rate Limiting

```javascript
async function checkRateLimit(ip, limit = 100, window = 60) {
  const key = `ratelimit:${ip}`;
  const current = await env.MY_KV.get(key);
  const count = current ? parseInt(current) : 0;
  
  if (count >= limit) {
    return false; // Rate limited
  }
  
  await env.MY_KV.put(key, (count + 1).toString(), { expirationTtl: window });
  return true;
}
```

## Limitations

| Feature | Limit |
|---------|-------|
| Key size | 512 bytes |
| Value size | 25 MB (Workers Paid), 1 MB (Free) |
| List keys | 1000 per request |
| Consistency | Eventual (1-60 seconds global) |

## Pricing

- Free: 100,000 reads/day, 1,000 writes/day
- Paid: $0.50/million reads, $5/million writes

## Documentation

- [Cloudflare KV](https://developers.cloudflare.com/kv/)
- [Workers Runtime APIs](https://developers.cloudflare.com/workers/runtime-apis/kv/)
