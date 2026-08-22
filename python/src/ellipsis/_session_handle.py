"""The session lifecycle sugar: a handle over one agent session.

Hand-written by design (the start -> stream -> message -> stop flow is an
ergonomics judgment, not a projection of the spec). Everything the handle
does rides the generated core + the stream client; it only carries the
session id and the resume cursor.

    client = Ellipsis(api_key=...)
    handle = client.sessions.run(prompt="fix the flaky test")
    handle.send("also update the changelog")
    session = handle.wait()          # poll to terminal

    async with AsyncEllipsis(api_key=...) as client:
        handle = await client.sessions.run(prompt="...")
        outcome = await handle.stream(on_frame=print)   # live frames (WS)
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from . import frames, models
from ._stream import DEFAULT_MAX_RECONNECTS, StreamOutcome, stream_session

if TYPE_CHECKING:
    from ._client import _AsyncSessions, _SyncSessions

# Statuses after which a session's execution will not progress without new
# input; `wait()` returns when one is reached.
TERMINAL_STATUSES = frozenset({"completed", "error", "cancelled", "stopped"})

DEFAULT_POLL_INTERVAL_SECONDS = 3.0


class SessionHandle:
    """One started session, on the sync client."""

    def __init__(self, sessions: "_SyncSessions", session: models.Session) -> None:
        self._sessions = sessions
        self.id = session.id
        self.session = session  # the latest session snapshot this handle saw

    def refresh(self) -> models.Session:
        self.session = self._sessions.get(self.id).session
        return self.session

    def wait(
        self,
        *,
        timeout: float | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> models.Session:
        """Poll until the session reaches a terminal status (or a parked
        conversation: state `idle`/`closed` with no live execution)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            session = self.refresh()
            if _settled(session):
                return session
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"session {self.id} not terminal after {timeout}s")
            time.sleep(poll_interval)

    def send(
        self, message: str, *, idempotency_key: str | None = None
    ) -> models.SessionMessage:
        """Post into the session's inbox (delivered at the next turn
        boundary; wakes a parked session)."""
        response = self._sessions.send_message(
            self.id, message=message, idempotency_key=idempotency_key
        )
        return response.message

    def stop(self) -> models.Session:
        self.session = self._sessions.stop(self.id).session
        return self.session

    def records(self, *, cursor: str | None = None, limit: int | None = None):
        return self._sessions.records(self.id, cursor=cursor, limit=limit)


class AsyncSessionHandle:
    """One started session, on the async client — adds `stream()`."""

    def __init__(self, sessions: "_AsyncSessions", session: models.Session) -> None:
        self._sessions = sessions
        self.id = session.id
        self.session = session

    async def refresh(self) -> models.Session:
        self.session = (await self._sessions.get(self.id)).session
        return self.session

    async def wait(
        self,
        *,
        timeout: float | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
    ) -> models.Session:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            session = await self.refresh()
            if _settled(session):
                return session
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"session {self.id} not terminal after {timeout}s")
            await asyncio.sleep(poll_interval)

    async def send(
        self, message: str, *, idempotency_key: str | None = None
    ) -> models.SessionMessage:
        response = await self._sessions.send_message(
            self.id, message=message, idempotency_key=idempotency_key
        )
        return response.message

    async def stop(self) -> models.Session:
        self.session = (await self._sessions.stop(self.id)).session
        return self.session

    async def records(self, *, cursor: str | None = None, limit: int | None = None):
        return await self._sessions.records(self.id, cursor=cursor, limit=limit)

    async def stream(
        self,
        on_frame: Callable[[frames.StreamFrame], None | Awaitable[None]],
        *,
        after_seq: int = 0,
        max_reconnects: int = DEFAULT_MAX_RECONNECTS,
    ) -> StreamOutcome:
        """Stream this session live over the WebSocket (protocol v3),
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


def _settled(session: models.Session) -> bool:
    if session.status in TERMINAL_STATUSES:
        return True
    # A keyed conversation parked between turns: the execution finished and
    # nothing runs until new input arrives.
    return session.session_state in ("idle", "closed")


__all__ = [
    "TERMINAL_STATUSES",
    "AsyncSessionHandle",
    "AsyncSessionsSugar",
    "SessionHandle",
    "SyncSessionsSugar",
]
