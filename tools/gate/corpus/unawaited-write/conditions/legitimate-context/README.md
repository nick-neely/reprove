# audit

Appends audit entries to a durable store.

The clock is injectable so tests and replay tooling can pin timestamps;
defaulting it to `Date.now` is the intended production behavior.
