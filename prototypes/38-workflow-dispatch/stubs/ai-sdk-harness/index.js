// Stands in for @ai-sdk/harness + the three bridges. Its only job in this
// prototype is to be a dependency edge the boundary check can see: if this
// package is reachable from @proto38/control-plane, ADR 0010's headline
// property ("a control plane that dispatches only to self-hosted Workers
// installs no harness code at all") is false.
export const HARNESS_MARKER = 'ai-sdk-harness';
