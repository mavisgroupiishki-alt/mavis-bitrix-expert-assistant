# MAVIS Bitrix Expert Assistant Constitution

## Principles

### I. Test contact isolation
Any pilot AI action MUST verify the explicitly configured test phone tail and deal ID before reading CRM context, creating a timeline entry, task, or outbound message.

### II. Conservative sales communication
The pilot MUST hand off price, discount, deadline, guarantee, payment, legal, conflict, or unclear requests to a human. It MUST NOT invent commercial facts.

### III. Preserve existing traffic
The existing Wazzup webhook MUST acknowledge and process non-test traffic exactly as before. Pilot failure MUST result in no outbound message.

### IV. Traceable outcomes
Every test inbound message and decision MUST be recorded against the test deal without exposing secrets.

## Constraints

- Scope is deal `38072` and the verified phone ending in `5898` only.
- Wazzup API secrets remain environment variables.
- Deployment needs explicit user approval.

## Working process

Changes require a targeted verification plus review of the Git diff before deployment.

## Governance

This constitution has priority over feature implementation decisions.

**Version**: 1.0.0 | **Ratified**: 2026-09-08 | **Last Amended**: 2026-09-08
