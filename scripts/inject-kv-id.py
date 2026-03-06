import json
import sys
import re

# Read the file
with open('wrangler.jsonc', 'r') as f:
    content = f.read()

# Remove comments (both // and /* */ style)
content = re.sub(r'//.*', '', content)  # Remove // comments
content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)  # Remove /* */ comments

# Remove trailing commas and whitespace
content = re.sub(r',\s*([}\]])', r'\1', content)

# Parse and modify
data = json.loads(content)
data['kv_namespaces'][0]['id'] = sys.argv[1]

# Write back as clean JSON
with open('wrangler.jsonc', 'w') as f:
    json.dump(data, f, indent=2)

print("KV Namespace ID injected")
