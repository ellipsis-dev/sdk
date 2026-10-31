"""The session lifecycle sugar: a handle over one agent session.

Hand-written by design (the start -> stream -> message -> stop flow is an
ergonomics judgment, not a projection of the spec). Everything the handle
does rides the generated core + the stream client; it only carries the
session id and the message it is waiting on.

    client = Ellipsis(api_key=...)
    handle = client.sessions.run(claude_code={"prompt": "fix the flaky test"})
    handle.send("also update the changelog")
    ended = handle.wait()            # the message_ended record's payload

    async with AsyncEllipsis(api_key=...) as client:
        handle = await client.sessions.run(claude_code={"prompt": "..."})
        outcome = await handle.stream(on_frame=print)   # live frames (WS)
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from . import frames, lifecycle, models
from ._stream import DEFAULT_MAX_RECONNECTS, StreamOutcome, stream_session

if TYPE_CHECKING:
    from ._client import _AsyncSessions, _SyncSessions

SETTLED_SESSION_STATUSES = frozenset({"idle", "closed"})

DEFAULT_POLL_INTERVAL_SECONDS = 3.0


def is_session_settled(status: object) -> bool:
    """Whether every message sent to the session has been answered: the
    session is idle or closed."""
    return str(status) in SETTLED_SESSION_STATUSES


def _message_ended(records: Any, message_id: str | None) -> Any:
    """The message_ended payload among `records`: the one for `message_id`,
    else the last one."""
    ended = None
    for record in records:
        if getattr(record, "record_type", None) != "message_ended":
            continue
        if message_id is None or getattr(record, "message_id", None) == message_id:
            ended = record.payload
    return ended


class SessionHandle:
    """One started session, on the sync client."""

    def __init__(self, sessions: "_SyncSessions", session: models.Session) -> None:
        self._sessions = sessions
        self.id = session.id
        self.session = session
        self.message_id: str | None = None

    def refresh(self) -> models.Session:
        self.session = self._sessions.get(self.id).session
        return self.session

    def wait(
        self,
        *,
        timeout: float | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> lifecycle.MessageEndedPayload | None:
        """Poll until the session is idle or closed, then return how the
        message this handle waits on ended (the `message_ended` record's
        payload): the last message sent through `send()`, else the session's
        latest message. None when the session has no message."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            session = self.refresh()
            if is_session_settled(session.status):
                break
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"session {self.id} not settled after {timeout}s")
            time.sleep(poll_interval)
        return _message_ended(
            self._sessions.records(self.id, message_id=self.message_id),
            self.message_id,
        )

    def send(
        self,
        message: str,
        *,
        images: list[models.ImageAttachment] | None = None,
        idempotency_key: str | None = None,
    ) -> models.SessionMessage:
        """Send a message to the session; `wait()` then waits for it to be
        answered. `images` ride the message as content blocks the model sees."""
        response = self._sessions.send_message(
            self.id, message=message, images=images, idempotency_key=idempotency_key
        )
        self.message_id = response.message.id
        return response.message

    def stop(self) -> models.Session:
        self.session = self._sessions.stop(self.id).session
        return self.session

    def records(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        message_id: str | None = None,
    ):
        return self._sessions.records(
            self.id, cursor=cursor, limit=limit, message_id=message_id
        )


class AsyncSessionHandle:
    """One started session, on the async client; adds `stream()`."""

    def __init__(self, sessions: "_AsyncSessions", session: models.Session) -> None:
        self._sessions = sessions
        self.id = session.id
        self.session = session
        self.message_id: str | None = None

    async def refresh(self) -> models.Session:
        self.session = (await self._sessions.get(self.id)).session
        return self.session

    async def wait(
        self,
        *,
        timeout: float | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> lifecycle.MessageEndedPayload | None:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            session = await self.refresh()
            if is_session_settled(session.status):
                break
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"session {self.id} not settled after {timeout}s")
            await asyncio.sleep(poll_interval)
        page = await self._sessions.records(self.id, message_id=self.message_id)
        return _message_ended([record async for record in page], self.message_id)

    async def send(
        self,
        message: str,
        *,
        images: list[models.ImageAttachment] | None = None,
        idempotency_key: str | None = None,
    ) -> models.SessionMessage:
        response = await self._sessions.send_message(
            self.id, message=message, images=images, idempotency_key=idempotency_key
        )
        self.message_id = response.message.id
        return response.message

    async def stop(self) -> models.Session:
        self.session = (await self._sessions.stop(self.id)).session
        return self.session

    async def records(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        message_id: str | None = None,
    ):
        return await self._sessions.records(
            self.id, cursor=cursor, limit=limit, message_id=message_id
        )

    async def stream(
        self,
        on_frame: Callable[[frames.StreamFrame], None | Awaitable[None]],
        *,
        after_seq: int = 0,
        max_reconnects: int = DEFAULT_MAX_RECONNECTS,
    ) -> StreamOutcome:
        """Stream this session live over the WebSocket,
        reconnecting and resuming automatically. Needs the `[stream]` extra."""
        transport = self._sessions._transport
        return await stream_session(
            session_id=self.id,
            api_key=transport.api_key,
            base_url=transport.base_url,
            on_frame=on_frame,
            after_seq=after_seq,
            max_reconnects=max_reconnects,
        )


class SyncSessionsSugar:
    """Mixin on the generated sync `sessions` namespace: the lifecycle sugar
    (`run`, `handle`) beside the generated methods."""

    def run(self, **start_kwargs) -> SessionHandle:
        """Start a session and return a handle over it. Accepts exactly
        `sessions.start`'s keyword arguments."""
        response = self.start(**start_kwargs)  # type: ignore[attr-defined]
        return SessionHandle(self, response.session)  # type: ignore[arg-type]

    def handle(self, session_id: str) -> SessionHandle:
        """A handle over an existing session."""
        response = self.get(session_id)  # type: ignore[attr-defined]
        return SessionHandle(self, response.session)  # type: ignore[arg-type]


class AsyncSessionsSugar:
    """The async twin of SyncSessionsSugar."""

    async def run(self, **start_kwargs) -> AsyncSessionHandle:
        response = await self.start(**start_kwargs)  # type: ignore[attr-defined]
        return AsyncSessionHandle(self, response.session)  # type: ignore[arg-type]

    async def handle(self, session_id: str) -> AsyncSessionHandle:
        response = await self.get(session_id)  # type: ignore[attr-defined]
        return AsyncSessionHandle(self, response.session)  # type: ignore[arg-type]


__all__ = [
    "SETTLED_SESSION_STATUSES",
    "AsyncSessionHandle",
    "AsyncSessionsSugar",
    "SessionHandle",
    "SyncSessionsSugar",
    "is_session_settled",
]
