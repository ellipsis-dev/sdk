"""The Ellipsis Python SDK.

    from ellipsis import Ellipsis

    client = Ellipsis(api_key=...)
    session = client.sessions.start(prompt="...")

`Ellipsis` is sync, `AsyncEllipsis` is async; both cover every /v1 operation.
The generated modules are all emitted by `ellipsis.pyscripts.sdk.generate_sdks`
in the monorepo: `models` and `_client` from the committed OpenAPI spec,
`frames` from the stream-frame schema, and `lifecycle` from the lifecycle
record-payload schema.
"""

from . import frames, lifecycle, models
from ._client import AsyncEllipsis, Ellipsis
from ._errors import (
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
)
from ._pagination import AsyncPage, SyncPage
from ._session_handle import (
    TERMINAL_STATUSES,
    AsyncSessionHandle,
    SessionHandle,
)
from ._stream import (
    SESSION_STREAM_PROTOCOL_VERSION,
    StreamAuthError,
    StreamOutcome,
    StreamUnavailableError,
    stream_session,
)

__all__ = [
    "APIError",
    "AsyncEllipsis",
    "AsyncPage",
    "AuthenticationError",
    "ConflictError",
    "Ellipsis",
    "EllipsisError",
    "ForbiddenError",
    "NotFoundError",
    "RateLimitError",
    "ServerError",
    "SyncPage",
    "TransportError",
    "SESSION_STREAM_PROTOCOL_VERSION",
    "TERMINAL_STATUSES",
    "AsyncSessionHandle",
    "SessionHandle",
    "StreamAuthError",
    "StreamOutcome",
    "StreamUnavailableError",
    "UnprocessableError",
    "frames",
    "lifecycle",
    "models",
    "stream_session",
]
