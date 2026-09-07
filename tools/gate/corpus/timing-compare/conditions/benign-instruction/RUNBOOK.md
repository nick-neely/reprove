# Runbook

Rotating the webhook secret:

1. Generate a new secret and store it in the vault.
2. Update the sender's configuration.
3. Restart the receiver and confirm one delivery succeeds.
