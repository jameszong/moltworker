---
name: d1-database
description: Cloudflare D1 SQL database operations. Query and manage relational data with SQLite-compatible SQL at the edge.
---

# Cloudflare D1 Database Skill

Cloudflare D1 SQL database operations for relational data at the edge.

## Features

- SQLite-compatible SQL
- ACID transactions
- Prepared statements
- Batch queries
- Edge-replicated reads
- JSON functions

## Environment Variables

```bash
# D1 database binding (configure in wrangler.toml)
DB=your_d1_database_binding
```

## Usage Examples

### wrangler.toml Configuration

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "your-database-id"
```

### Create Table

```javascript
await env.DB.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
```

### Insert Data

```javascript
const result = await env.DB.prepare(
  'INSERT INTO users (email, name) VALUES (?, ?)'
)
.bind('john@example.com', 'John Doe')
.run();

console.log('Inserted row ID:', result.meta.last_row_id);
```

### Named Parameters

```javascript
const result = await env.DB.prepare(
  'INSERT INTO users (email, name) VALUES (:email, :name)'
)
.bind({ email: 'jane@example.com', name: 'Jane Doe' })
.run();
```

### Query Data

```javascript
const { results } = await env.DB.prepare(
  'SELECT * FROM users WHERE email = ?'
)
.bind('john@example.com')
.all();

console.log(results);
// [{ id: 1, email: 'john@example.com', name: 'John Doe', created_at: '2024-...' }]
```

### First Row Only

```javascript
const row = await env.DB.prepare(
  'SELECT * FROM users WHERE id = ?'
)
.bind(1)
.first();

console.log(row?.name); // 'John Doe'
```

### Raw Query Results

```javascript
const { results, success, meta } = await env.DB.prepare(
  'SELECT COUNT(*) as count FROM users'
).all();

console.log(`Total users: ${results[0].count}`);
```

### Batch Queries

```javascript
const statements = [
  env.DB.prepare('INSERT INTO users (email, name) VALUES (?, ?)').bind('a@test.com', 'User A'),
  env.DB.prepare('INSERT INTO users (email, name) VALUES (?, ?)').bind('b@test.com', 'User B'),
  env.DB.prepare('INSERT INTO users (email, name) VALUES (?, ?)').bind('c@test.com', 'User C'),
];

const results = await env.DB.batch(statements);
```

### Transactions

```javascript
// D1 supports ACID transactions automatically per statement
// For multi-statement transactions, use batch

const transfer = async (fromId, toId, amount) => {
  const statements = [
    env.DB.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').bind(amount, fromId),
    env.DB.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').bind(amount, toId),
    env.DB.prepare('INSERT INTO transactions (from_id, to_id, amount) VALUES (?, ?, ?)')
      .bind(fromId, toId, amount),
  ];
  
  return await env.DB.batch(statements);
};
```

## Common Patterns

### User Management

```javascript
class UserStore {
  constructor(db) {
    this.db = db;
  }

  async create(email, name) {
    return await this.db.prepare(
      'INSERT INTO users (email, name) VALUES (?, ?) RETURNING *'
    ).bind(email, name).first();
  }

  async findById(id) {
    return await this.db.prepare('SELECT * FROM users WHERE id = ?')
      .bind(id).first();
  }

  async findByEmail(email) {
    return await this.db.prepare('SELECT * FROM users WHERE email = ?')
      .bind(email).first();
  }

  async update(id, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), id];
    
    return await this.db.prepare(`UPDATE users SET ${fields} WHERE id = ?`)
      .bind(...values).run();
  }

  async delete(id) {
    return await this.db.prepare('DELETE FROM users WHERE id = ?')
      .bind(id).run();
  }
}
```

### JSON Columns

```javascript
// Store JSON data
await env.DB.prepare(
  'INSERT INTO events (type, data) VALUES (?, json(?))'
).bind('user_action', JSON.stringify({ action: 'login', ip: '1.2.3.4' })).run();

// Query JSON
const events = await env.DB.prepare(
  "SELECT * FROM events WHERE json_extract(data, '$.action') = ?"
).bind('login').all();
```

## Limitations

| Feature | Limit |
|---------|-------|
| Database size | 500 MB (Free), 50 GB (Paid) |
| Rows per query | 100,000 |
| Query timeout | 30 seconds |
| Connection | HTTP-based, not persistent |

## Pricing

- Free: 5M rows read/day, 100K rows written/day
- Paid: $1 per million rows read, $1 per million rows written

## Documentation

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [SQL Reference](https://developers.cloudflare.com/d1/sql/)
- [Workers Binding](https://developers.cloudflare.com/workers/runtime-apis/d1/)
