# Security policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities or leaked credentials. Use GitHub private vulnerability reporting after it is enabled for the repository, or contact the repository owner through a private channel.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not access data that you do not own while testing.

## Supported versions

Until version 1.0, only the latest tagged release receives security fixes.

## Non-negotiable deployment requirements

- Keep the repository private until threat modeling and deployment review are complete.
- Do not commit `.env` files, tokens, credentials, production data, or raw customer conversations.
- Require an identity-aware gateway in production.
- Run the service with a read-only filesystem, no Linux capabilities, and a non-root user.
- Keep the policy bundle and action registry write-protected from the agent runtime.
- Enforce tenant boundaries in every backing store, including vector indexes.
- Use a dedicated secrets manager and short-lived credentials.
- Record immutable authorization and execution audit events.

The reference API is a policy decision and validation component. It is not a complete authorization perimeter by itself.
