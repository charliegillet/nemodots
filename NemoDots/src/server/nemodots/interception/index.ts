// OpenDots tool-path interception (defence in depth). The guarantee that a
// controlled change rests on current evidence is enforced by the action
// boundary (G1/G2), not by this package; these hooks narrow what an OpenDots
// Dot can reach and record what it saw. Every hook is optional and a no-op
// until bootstrap installs a policy or a runtime.
export * from './active-policy.js';
export * from './active-runtime.js';
export * from './approval-revalidation.js';
export * from './fetch-telemetry.js';
export * from './policy-registry.js';
export * from './provenance-middleware.js';
export * from './provenance-scope.js';
export * from './with-tool-policy.js';
