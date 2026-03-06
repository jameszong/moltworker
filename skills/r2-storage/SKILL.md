---
name: r2-storage
description: Cloudflare R2 object storage operations for files, images, and backups. S3-compatible API with zero egress fees.
---

# Cloudflare R2 Storage Skill

Cloudflare R2 object storage for files, images, and backups with S3-compatible API.

## Features

- S3-compatible API
- Zero egress fees
- Automatic CDN caching
- Pre-signed URLs
- Multipart uploads
- Public/private buckets

## Environment Variables

```bash
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
CF_ACCOUNT_ID=your_cloudflare_account_id
R2_BUCKET_NAME=my-bucket
R2_PUBLIC_URL=https://pub-xxx.r2.dev  # Custom domain or public URL
```

## Usage Examples

### Using AWS SDK

```javascript
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
```

### Upload Object

```javascript
await s3.send(new PutObjectCommand({
  Bucket: R2_BUCKET_NAME,
  Key: 'uploads/document.pdf',
  Body: fileBuffer,
  ContentType: 'application/pdf',
}));
```

### Upload with Metadata

```javascript
await s3.send(new PutObjectCommand({
  Bucket: R2_BUCKET_NAME,
  Key: 'images/photo.jpg',
  Body: imageBuffer,
  ContentType: 'image/jpeg',
  Metadata: {
    'original-name': 'vacation.jpg',
    'uploaded-by': 'user123',
  },
}));
```

### Download Object

```javascript
const response = await s3.send(new GetObjectCommand({
  Bucket: R2_BUCKET_NAME,
  Key: 'uploads/document.pdf',
}));

const fileBuffer = await response.Body.transformToByteArray();
```

### Generate Pre-signed URL

```javascript
// For uploads
const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
  Bucket: R2_BUCKET_NAME,
  Key: 'uploads/user-file.jpg',
  ContentType: 'image/jpeg',
}), { expiresIn: 300 }); // 5 minutes

// For downloads
const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
  Bucket: R2_BUCKET_NAME,
  Key: 'private/document.pdf',
}), { expiresIn: 3600 }); // 1 hour
```

### Delete Object

```javascript
await s3.send(new DeleteObjectCommand({
  Bucket: R2_BUCKET_NAME,
  Key: 'uploads/old-file.txt',
}));
```

### List Objects

```javascript
import { ListObjectsV2Command } from '@aws-sdk/client-s3';

const response = await s3.send(new ListObjectsV2Command({
  Bucket: R2_BUCKET_NAME,
  Prefix: 'uploads/',
  MaxKeys: 100,
}));

for (const object of response.Contents || []) {
  console.log(object.Key, object.Size, object.LastModified);
}
```

### Public URL

```javascript
// If bucket is public or using custom domain
function getPublicUrl(key) {
  return `${R2_PUBLIC_URL}/${key}`;
}

// Usage
const imageUrl = getPublicUrl('images/photo.jpg');
// https://pub-xxx.r2.dev/images/photo.jpg
```

## Common Patterns

### File Upload Handler

```javascript
async function handleUpload(file, userId) {
  const key = `uploads/${userId}/${Date.now()}-${file.name}`;
  
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: file.stream(),
    ContentType: file.type,
    Metadata: {
      'user-id': userId,
      'original-name': file.name,
    },
  }));
  
  return { key, url: getPublicUrl(key) };
}
```

### Image Resizing Worker

```javascript
// Workers can resize images before storing
async function uploadResizedImage(file, width, height) {
  // Resize using sharp or similar
  const resizedBuffer = await resizeImage(file, width, height);
  
  const key = `thumbnails/${width}x${height}/${file.name}`;
  
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: resizedBuffer,
    ContentType: 'image/jpeg',
  }));
  
  return key;
}
```

### Backup System

```javascript
async function createBackup(data, name) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `backups/${name}-${timestamp}.json`;
  
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
    Metadata: {
      'backup-type': name,
      'created-at': new Date().toISOString(),
    },
  }));
  
  return key;
}
```

## Bucket Configuration

### Make Bucket Public

```bash
# Using rclone
rclone config  # Add R2 remote
rclone serve http r2remote:bucketname --addr :8080
```

### Custom Domain

```bash
# In Cloudflare dashboard
# 1. Add custom domain to R2 bucket
# 2. Create CNAME record
# 3. Enable Cloudflare proxy
```

## Pricing

- Storage: $0.015/GB-month
- Class A operations: $4.50/million
- Class B operations: $0.36/million
- **Egress: FREE**

## Limits

| Feature | Limit |
|---------|-------|
| Object size | 5 TB |
| Upload (single) | 100 MB |
| Upload (multipart) | 5 TB |
| Custom metadata | 2 KB |

## Documentation

- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [S3 API Compatibility](https://developers.cloudflare.com/r2/api/s3-api/)
- [Workers Integration](https://developers.cloudflare.com/r2/api/workers/)
