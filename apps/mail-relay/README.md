#### Environment variables

- `RELAY_BIND_HOST`: Address to bind the SMTP listener to. Defaults to `0.0.0.0`.
- `RELAY_PORT`: SMTP listener port. Defaults to `2525`.
- `RELAY_HOSTNAME`: SMTP banner hostname shown to clients. Defaults to `mos-mail-relay`.
- `RELAY_USERNAME`: Required SMTP auth username accepted by the relay.
- `RELAY_PASSWORD`: Required SMTP auth password accepted by the relay.
- `RELAY_ALLOW_INSECURE_AUTH`: Allows plain SMTP auth without STARTTLS. Defaults to `true` for simple platform deployment on custom TCP ports.
- `RELAY_MAX_MESSAGE_BYTES`: Maximum accepted SMTP message size in bytes. Defaults to `262144`.
- `RELAY_MAX_RECIPIENTS_PER_MESSAGE`: Maximum number of recipients per message. Defaults to `10`.
- `RELAY_RATE_LIMIT_WINDOW_MS`: Rate-limit window in milliseconds. Defaults to `60000`.
- `RELAY_RATE_LIMIT_MAX_MESSAGES`: Maximum accepted messages per auth user within the rate-limit window. Defaults to `20`.
- `RELAY_ALLOW_ATTACHMENTS`: Enables/disables attachment forwarding. Defaults to `false`.
- `RESEND_API_KEY`: Required Resend API key used for final delivery.
- `RESEND_FROM`: Required sender email address used for sender rewrite on every accepted message.
- `RESEND_FROM_NAME`: Optional display name paired with `RESEND_FROM`.
- `RESEND_API_AUDIENCE`: Optional Resend API URL override. Defaults to `https://api.resend.com/emails`.

#### Runtime behavior

- Accepts standard SMTP AUTH and forwards accepted mail through the Resend HTTP API.
- Rewrites the visible sender to `RESEND_FROM` so relay clients cannot impersonate arbitrary domains.
- Uses the original SMTP envelope sender as `reply_to` when available.
- Rejects oversized messages, too many recipients, and attachments by default.
- Applies simple in-memory rate limiting per authenticated SMTP username.

#### Intended use

- Designed as a small transparent transactional relay for platform environments where apps support SMTP but direct outbound SMTP is restricted or inconvenient.
- Intended for low-volume operational mail such as password resets, invitations, and share-link notifications.
- Not intended to be a newsletter platform, a general-purpose open relay, or a full mail server.

#### Operational notes

- Current protection is intentionally simple: one configured SMTP credential, sender rewrite, and lightweight rate limits.
- In-memory rate limits reset when the container restarts.
- STARTTLS is intentionally disabled in this first version to keep deployment simple on custom TCP proxy ports.
- Because final delivery uses Resend over HTTPS, the relay does not need direct outbound SMTP access.
