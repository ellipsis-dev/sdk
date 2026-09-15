// The generated client's error hierarchy. Every /v1 error is an
// `ErrorResponse` envelope carrying an `ErrorInfo` with a stable
// machine-readable `code` (an OPEN vocabulary — handle unknown codes by HTTP
// status, which is what this hierarchy does: class by status, `code` along
// for finer dispatch).

export class EllipsisError extends Error {}

// The request never produced an HTTP response (DNS, TLS, timeout).
export class TransportError extends EllipsisError {}

export class APIError extends EllipsisError {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(args: {
    status: number;
    code: string | null;
    message: string;
    requestId: string | null;
    body?: unknown;
  }) {
    super(`${args.status} ${args.code ?? 'error'}: ${args.message}`);
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.body = args.body;
  }
}

export class AuthenticationError extends APIError {}
export class ForbiddenError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
export class UnprocessableError extends APIError {}
export class RateLimitError extends APIError {}
export class ServerError extends APIError {}

const STATUS_CLASSES: Record<number, typeof APIError> = {
  401: AuthenticationError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableError,
  429: RateLimitError,
};

// Build the right exception for a non-2xx response body (the
// `{"error": {code, message, request_id}}` envelope when present; any other
// shape degrades to the raw body as the message).
export function apiErrorFor(status: number, body: unknown): APIError {
  let code: string | null = null;
  let message = '';
  let requestId: string | null = null;
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error !== null && typeof error === 'object') {
      const info = error as {
        code?: unknown;
        message?: unknown;
        request_id?: unknown;
      };
      if (typeof info.code === 'string') code = info.code;
      if (typeof info.message === 'string') message = info.message;
      if (typeof info.request_id === 'string') requestId = info.request_id;
    } else if ('detail' in (body as object)) {
      message = String((body as { detail: unknown }).detail);
    }
  }
  if (!message) {
    message = body == null ? 'no response body' : String(body).slice(0, 500);
  }
  const cls =
    STATUS_CLASSES[status] ?? (status >= 500 ? ServerError : APIError);
  return new cls({ status, code, message, requestId, body });
}
