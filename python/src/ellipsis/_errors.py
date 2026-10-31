"""The generated client's exception hierarchy.

Every /v1 error is an `ErrorResponse` envelope carrying an `ErrorInfo` with a
stable machine-readable `code` (an OPEN vocabulary — handle unknown codes by
HTTP status, which is exactly what this hierarchy does: the class is chosen by
status, and `code` rides along for finer dispatch).
"""

from typing import Any


class EllipsisError(Exception):
    """Base for every error this SDK raises."""


class TransportError(EllipsisError):
    """The request never produced an HTTP response (DNS, TLS, timeout)."""


class APIError(EllipsisError):
    """A non-2xx response from the API."""

    def __init__(
        self,
        *,
        status: int,
        code: str | None,
        message: str,
        request_id: str | None,
        body: Any = None,
    ) -> None:
        super().__init__(f"{status} {code or 'error'}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.body = body


class AuthenticationError(APIError):
    """401 — the bearer token is missing, invalid, or revoked."""


class ForbiddenError(APIError):
    """403 — authenticated, but not allowed to do this."""


class NotFoundError(APIError):
    """404 — no such resource in this account's scope."""


class ConflictError(APIError):
    """409 — the request conflicts with current state."""


class UnprocessableError(APIError):
    """422 — the request shape failed validation."""


class RateLimitError(APIError):
    """429 — slow down."""


class ServerError(APIError):
    """5xx — an error on our side."""


_STATUS_CLASSES: dict[int, type[APIError]] = {
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableError,
    429: RateLimitError,
}


def api_error_for(status: int, body: Any) -> APIError:
    """Build the right exception for a non-2xx response body (the
    `{"error": {code, message, request_id}}` envelope when present; any
    other shape degrades to the raw body as the message)."""
    code = None
    message = ""
    request_id = None
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            message = error.get("message") or ""
            request_id = error.get("request_id")
        elif isinstance(body.get("detail"), (str, list)):
            message = str(body["detail"])
    if not message:
        message = str(body)[:500] if body is not None else "no response body"
    cls = _STATUS_CLASSES.get(status) or (ServerError if status >= 500 else APIError)
    return cls(
        status=status, code=code, message=message, request_id=request_id, body=body
    )
