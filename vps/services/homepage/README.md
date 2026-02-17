# Homepage Dashboard Service

A self-hosted dashboard built on [Homepage](https://gethomepage.dev/) with template-based configuration.

## Architecture

This service uses a template-replacer pattern:

1. Define dashboard structure in `config/services.template.yaml`
2. Use `${ENV_VAR}` placeholders for dynamic values
3. At startup, the replacer generates `services.yaml` from the template
4. Services with unresolved placeholders are automatically removed
5. Empty categories are automatically removed

## File Structure

```
homepage/
├── config-generator/       # TypeScript template replacer
│   ├── src/index.ts
│   └── dist/              # Compiled JS (generated)
├── config/
│   ├── services.template.yaml  # Editable template
│   ├── bookmarks.yaml
│   ├── docker.yaml
│   ├── kubernetes.yaml
│   └── widgets.yaml
├── Dockerfile
├── entrypoint.sh
└── README.md
```

## Usage

Deploy using Docker Compose. Environment variables are passed through the compose file.

```bash
docker-compose up -d
```

## Customization

Edit `config/services.template.yaml` to customize the dashboard.

### Adding a Service

```yaml
- Category Name:
    - Service Name:
        href: ${SERVICE_URL}      # Placeholder, requires env var
        description: My service
        icon: service.png

- Static Category:
    - Static Service:
        href: https://example.com  # No placeholder, always appears
        description: Always visible
        icon: mdi:web
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VAULTWARDEN_URL` | Vaultwarden service URL |
| `TEST_MESSAGE` | Test message for demo tile |

Services without placeholders always appear. Services with placeholders only appear when their env vars are set.