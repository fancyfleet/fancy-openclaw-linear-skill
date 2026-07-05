// Global test setup: ensure LINEAR_PROXY_URL is unset by default.
// Tests that exercise proxy-governed behavior set it explicitly in beforeEach.
// This prevents the live environment from leaking into CLI payload assertions.
delete process.env.LINEAR_PROXY_URL;
