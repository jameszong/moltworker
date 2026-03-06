---
name: github
description: GitHub API integration for repository management, issues, pull requests, and workflows. Automate GitHub operations directly from OpenClaw.
---

# GitHub Skill

Complete GitHub API integration for repository management and automation.

## Features

- Repository management (create, delete, update)
- Issue tracking (create, update, close, comment)
- Pull request management
- Workflow automation
- Release management
- Code search

## Environment Variables

```bash
GITHUB_TOKEN=your_github_personal_access_token
GITHUB_API_URL=https://api.github.com  # Optional, for GitHub Enterprise
```

## Usage Examples

### Create an Issue

```bash
curl -X POST https://api.github.com/repos/{owner}/{repo}/issues \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -d '{
    "title": "Bug report",
    "body": "Something is broken",
    "labels": ["bug"]
  }'
```

### Create a Pull Request

```bash
curl -X POST https://api.github.com/repos/{owner}/{repo}/pulls \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -d '{
    "title": "Feature implementation",
    "head": "feature-branch",
    "base": "main",
    "body": "This PR adds new features"
  }'
```

### List Repositories

```bash
curl https://api.github.com/user/repos \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json"
```

### Search Code

```bash
curl "https://api.github.com/search/code?q=filename:package.json+repo:owner/repo" \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json"
```

### Trigger Workflow

```bash
curl -X POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  -d '{
    "ref": "main",
    "inputs": {
      "environment": "production"
    }
  }'
```

## Token Permissions

Required token scopes:
- `repo` - Full repository access
- `workflow` - Manage workflows
- `write:packages` - Publish packages

## API Rate Limits

- Authenticated: 5,000 requests per hour
- GitHub App: Higher limits based on installation

## Documentation

- [GitHub REST API](https://docs.github.com/en/rest)
- [GitHub GraphQL API](https://docs.github.com/en/graphql)
