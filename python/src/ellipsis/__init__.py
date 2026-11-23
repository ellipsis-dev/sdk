"""The Ellipsis Python SDK.

    from ellipsis import ClaudeCodeConfig, Ellipsis

    client = Ellipsis(api_key=...)
    session = client.sessions.start(
        claude_code=ClaudeCodeConfig(model="claude-opus-5-5", prompt="..."),
    )

Every model and enum imports from the package itself.

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
    SETTLED_SESSION_STATUSES,
    AsyncSessionHandle,
    SessionHandle,
    is_session_settled,
)
from ._stream import (
    StreamAuthError,
    StreamOutcome,
    StreamUnavailableError,
    aiter_session_stream,
    iter_session_stream,
    stream_session,
)
from ._transport import NOT_GIVEN, NotGiven

# Every model and enum is importable from the package itself:
# `from ellipsis import AgentConfig, GithubAction`.
from .models import *  # noqa: F403

__all__ = [
    "APIError",
    "AsyncEllipsis",
    "AsyncPage",
    "AuthenticationError",
    "ConflictError",
    "Ellipsis",
    "EllipsisError",
    "NOT_GIVEN",
    "NotGiven",
    "ForbiddenError",
    "NotFoundError",
    "RateLimitError",
    "ServerError",
    "SyncPage",
    "TransportError",
    "SETTLED_SESSION_STATUSES",
    "is_session_settled",
    "AsyncSessionHandle",
    "SessionHandle",
    "StreamAuthError",
    "StreamOutcome",
    "StreamUnavailableError",
    "UnprocessableError",
    "aiter_session_stream",
    "frames",
    "iter_session_stream",
    "lifecycle",
    "models",
    "stream_session",
]
__all__ += models.__all__
