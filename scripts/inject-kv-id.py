import json
import sys

# Read the file
with open('wrangler.jsonc', 'r') as f:
    content = f.read()

# Remove comments (simple approach)
lines = content.split('\n')
clean_lines = []
for line in lines:
    # Remove inline comments
    if '//' in line:
        line = line[:line.index('//')]
    clean_lines.append(line)

clean_content = '\n'.join(clean_lines)

# Parse and modify
data = json.loads(clean_content)
data['kv_namespaces'][0]['id'] = sys.argv[1]

# Write back (preserving comments)
with open('wrangler.jsonc', 'w') as f:
    json.dump(data, f, indent=2)

print("KV Namespace ID injected")
