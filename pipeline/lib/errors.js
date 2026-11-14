/**
 * Error raised by provider adapters. Messages never include request headers or tokens.
 * kind: 'config' | 'network' | 'http' | 'rate_limit' | 'parse'
 */
export class ProviderError extends Error {
  constructor({ provider, kind, message, status = null, retryAfterMs = null, cause = undefined }) {
    super(`[${provider}] ${message}`, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
