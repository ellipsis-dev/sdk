// @ellipsis-dev/sdk — the TypeScript SDK for the Ellipsis agents platform.
//
//   .          this module: generated REST types + the generated client
//   ./stream   the session stream WebSocket client (reconnect/resume)
//   ./store    the session transcript store + pure shaping helpers
//
// The client core (`Ellipsis`) is generated from the committed OpenAPI spec
// plus the operation map — one method per /v1 operation, cursor pagination
// walked transparently. The transport is hand-written once (bearer auth,
// retries, typed errors) and zero-dependency so the CLI's `bun --compile`
// can bundle it.

export * from './types';
export { Ellipsis } from './core/client';
export {
  APIError,
  AuthenticationError,
  ConflictError,
  EllipsisError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TransportError,
  UnprocessableError,
} from './core/errors';
export { Page } from './core/pagination';
export {
  SessionHandle,
  TERMINAL_STATUSES,
  isSettled,
} from './core/sessionHandle';
export {
  DEFAULT_BASE_URL,
  Transport,
  type TransportOptions,
} from './core/transport';
