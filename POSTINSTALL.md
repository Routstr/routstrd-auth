Routstrd Auth is now installed.

The app exposes an OpenAI-compatible Routstr endpoint protected by bearer-token auth. Persistent wallet/config/database data is stored under Cloudron's app data directory and included in backups.

If you need admin-only client management endpoints, configure `ROUTSTRD_AUTH_ADMIN_PUBKEYS` (comma-separated Nostr npub or hex pubkeys) in the app's Cloudron environment variables and restart the app.
