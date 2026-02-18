# Homepage Dashboard Service

A self-hosted dashboard for the My-Own-Suite project, built on [Homepage](https://gethomepage.dev/) with template-based configuration.

## Architecture Overview

This service uses a **template-replacer** pattern: a YAML template defines the dashboard structure, and placeholders are replaced with environment variable values at container startup. Services with unresolved placeholders are automatically removed.

```
┌────────────────────────────────────────────────────────────┐
│                    Container Startup                       │
│                                                            │
│  ┌─────────────────┐    ┌─────────────────────────────┐    │
│  │   Env Vars      │    │   Template Replacer (TS)    │    │
│  │                 │───>│                             │    │
│  │ VAULTWARDEN_URL │    │   - Reads template          │    │
│  │ ...             │    │   - Replaces ${VAR} values  │    │
│  └─────────────────┘    │   - Removes unresolved      │    │
│                         │   - Outputs services.yaml   │    │
│                         └──────────────┬──────────────┘    │
│                                        │                   │
│                                        ▼                   │
│                         ┌─────────────────────────────┐    │
│                         │   services.yaml             │    │
│                         │   (generated config)        │    │
│                         └──────────────┬──────────────┘    │
│                                        │                   │
│                                        ▼                   │
│                         ┌─────────────────────────────┐    │
│                         │   Homepage Server           │    │
│                         │   (Node.js)                 │    │
│                         └─────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Template File

The dashboard structure is defined in `config/services.template.yaml`:

```yaml
- Security:
    - Vaultwarden:
        href: ${VAULTWARDEN_URL}
        description: Self-hosted password manager
        icon: vaultwarden.png

- Communication:
    - My Chat:
        href: ${CHAT_URL}
        description: Team chat
        icon: mdi:chat
```

### 2. Placeholder Replacement

The replacer finds `${ENV_VAR}` patterns and replaces them with environment variable values:

- If the env var is set → placeholder is replaced with the value
- If the env var is missing → the entire service is removed from output
- If all services in a category are removed → the category is removed

### 3. User Customization

Users can edit the template freely:

- Move categories around (reorder lines)
- Add custom services without env vars (static tiles)
- Change descriptions, icons, etc.
- Add new categories

## Enabling/Disabling Services

To enable a service:
- Set the required environment variable(s) for that service

To disable a service:
- Remove the environment variable
- Or remove/comment it from the template

The next deployment will automatically update the dashboard.

## Template Syntax

### Placeholders

```yaml
href: ${SERVICE_URL}           # Replaced with env var
description: Static text       # Left unchanged
icon: ${SERVICE_ICON}          # Can use multiple placeholders
```

### Static Services (no env vars)

```yaml
- Personal:
    - My Blog:
        href: https://myblog.com
        description: My personal blog
        icon: mdi:post
```

Services without placeholders always appear in the dashboard.

## File Structure

```
homepage/
├── config-generator/       # Template replacer
│   ├── src/
│   │   └── index.ts       # Replacer logic
│   └── dist/              # Compiled JavaScript (generated)
├── config/
│   ├── services.template.yaml  # Editable template
│   ├── bookmarks.yaml          # Static bookmarks
│   ├── docker.yaml             # Docker integration
│   ├── kubernetes.yaml         # Kubernetes integration
│   └── widgets.yaml            # Dashboard widgets
├── Dockerfile             # Multi-stage Docker build
├── entrypoint.sh          # Container startup script
└── README.md              # This file
```

## Building

The Dockerfile uses a multi-stage build:

1. **Stage 1 (Builder)**: Compiles TypeScript to JavaScript
2. **Stage 2 (Runtime)**: Copies compiled code and runs on Homepage base image

## Environment Variables

Each service in the template defines its own required environment variables through placeholders. Check the template for available variables.