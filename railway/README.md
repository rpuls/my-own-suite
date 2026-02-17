# Railway Deployment

Services deployed on [Railway](https://railway.app/).

## Services

| Service | Directory | Description |
|---------|-----------|-------------|
| Homepage | `services/homepage/` | Dashboard linking to all services |
| Vaultwarden | `services/vaultwarden/` | Password manager |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Railway Deployment                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌─────────────┐           ┌─────────────────────┐    │
│   │  Homepage   │           │     Vaultwarden     │    │
│   │             │           │                     │    │
│   │             │           │    PostgreSQL      │    │
│   └─────────────┘           └─────────────────────┘    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Railway handles:
- HTTPS/TLS termination
- Public domain routing
- Container orchestration