"""The session stream WebSocket client (protocol v3) — the Python mirror of
the TypeScript SDK's `./stream`: reconnect with capped backoff, `after_seq`
resume (only records_append frames advance the cursor), close-code
classification, and a heartbeat-lapse dead-socket rule.

Hand-written by design: the WS stream is not HTTP, so it cannot be generated
from the OpenAPI spec; its shape contract is `frames.schema.json` (the
generated `frames` module).
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

from . import frames
from ._errors import EllipsisError
from ._transport import DEFAULT_BASE_URL

# The one protocol version this client speaks; sent as `?protocol=` on the
# handshake and echoed by the snapshot frame.
SESSION_STREAM_PROTOCOL_VERSION = 3

WS_CLOSE_NORMAL = 1000
WS_CLOSE_UNSUPPORTED_PROTOCOL_VERSION = 1002
WS_CLOSE_NO_PROTOCOL = 1003
WS_CLOSE_AUTH_FAILED = 1008
WS_CLOSE_SERVER_ERROR = 1011
WS_CLOSE_OVER_CAPACITY = 1013

# Server heartbeat cadence is 20s; ~2x that of silence means a dead socket.
HEARTBEAT_TIMEOUT_SECONDS = 45.0
DEFAULT_MAX_RECONNECTS = 5

CloseKind = Literal["normal", "auth", "unsupported", "retry"]


class StreamUnavailableError(EllipsisError):
    """Streaming isn't usable (endpoint missing, protocol unsupported, or
    reconnects exhausted) — fall back to REST polling."""


class StreamAuthError(EllipsisError):
    """The server rejected the credential for this session. Polling would
    fail the same way; not a fallback case."""


@dataclass
class StreamOutcome:
    """How stream_session() finished. `done`/`error` are normal terminal
    outcomes; `aborted` means the caller cancelled."""

    type: Literal["done", "error", "aborted"]
    status: str = ""
    exit_status: str | None = None
    message: str = ""


def stream_query(after_seq: int) -> str:
    """The v3 handshake query: `?protocol=` is REQUIRED (no-protocol closes
    1003, unknown version closes 1002); after_seq omitted at 0 (full replay)."""
    base = f"protocol={SESSION_STREAM_PROTOCOL_VERSION}"
    return f"{base}&after_seq={after_seq}" if after_seq > 0 else base


def classify_close_code(code: int) -> CloseKind:
    if code == WS_CLOSE_NORMAL:
        return "normal"
    if code in (WS_CLOSE_AUTH_FAILED, 4401, 4403):
        return "auth"
    if code in (WS_CLOSE_UNSUPPORTED_PROTOCOL_VERSION, WS_CLOSE_NO_PROTOCOL):
        return "unsupported"
    return "retry"  # 1011 server error, 1013 over capacity, 1006 abnormal, …


def next_reconnect_delay_seconds(attempt: int) -> float:
    """Exponential backoff, capped. Deterministic (no jitter), same curve as
    the TS client."""
    return min(8.0, 0.5 * 2 ** max(0, attempt - 1))


@dataclass
class ReconnectDecision:
    action: Literal["reconnect", "fallback", "fail-auth"]
    delay_seconds: float = 0.0


def decide_reconnect(
    *,
    close_kind: CloseKind | None,
    ever_received_frame: bool,
    attempt: int,
    max_reconnects: int,
) -> ReconnectDecision:
    """What to do after a connection ends without a terminal frame. `attempt`
    counts CONSECUTIVE failed connections — the caller resets it once a
    connection delivers a frame, so a long-lived stream that hiccups every few
    hours never exhausts its budget. Persistent once the server has actually
    streamed; bails fast otherwise so a backend without the endpoint falls
    back promptly."""
    if close_kind == "auth":
        return ReconnectDecision("fail-auth")
    if close_kind == "unsupported":
        return ReconnectDecision("fallback")
    cap = max_reconnects if ever_received_frame else min(2, max_reconnects)
    if attempt >= cap:
        return ReconnectDecision("fallback")
    return ReconnectDecision("reconnect", next_reconnect_delay_seconds(attempt))


def parse_frame(data: str | bytes) -> frames.StreamFrame | None:
    """One wire message -> a typed frame, or None for anything to ignore
    (non-JSON keepalives, unknown frame types — additive server changes are
    not a protocol break)."""
    try:
        payload = json.loads(data)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    frame_cls = _FRAME_TYPES.get(payload.get("type"))
    if frame_cls is None:
        return None
    try:
        return frame_cls.model_validate(payload)
    except Exception:
        return None  # a malformed frame is ignored, like an unknown type


_FRAME_TYPES: dict[Any, Any] = {
    "snapshot": frames.SnapshotFrame,
    "records_append": frames.RecordsAppendFrame,
    "session": frames.SessionFrame,
    "delta": frames.DeltaFrame,
    "heartbeat": frames.HeartbeatFrame,
    "done": frames.DoneFrame,
    "error": frames.ErrorFrame,
}


def session_status_word(session: Any) -> str:
    """The display word for a session: the server-derived surface status when
    present, else the raw per-execution status — same rule as the TS client
    so stream and REST can never disagree."""
    surface = getattr(session, "surface", None)
    if surface is not None and getattr(surface, "status", None):
        return str(surface.status)
    return str(session.status)


def _ws_url(base_url: str, session_id: str, after_seq: int) -> str:
    root = base_url.rstrip("/")
    if root.startswith("https://"):
        root = "wss://" + root[len("https://") :]
    elif root.startswith("http://"):
        root = "ws://" + root[len("http://") :]
    session = quote(session_id, safe="")
    return f"{root}/v1/sessions/{session}/stream?{stream_query(after_seq)}"


async def stream_session(
    *,
    session_id: str,
    api_key: str,
    on_frame: Callable[[frames.StreamFrame], None | Awaitable[None]],
    base_url: str = DEFAULT_BASE_URL,
    after_seq: int = 0,
    max_reconnects: int = DEFAULT_MAX_RECONNECTS,
) -> StreamOutcome:
    """Stream an agent session to completion, reconnecting with backoff and
    resuming from the last records_append feed_seq so a dropped socket loses
    no records (only records advance the cursor — session/messages snapshots
    are re-sent fresh on reconnect). Calls `on_frame` for every frame.
    Cancel by cancelling the task (returns `aborted`). Raises
    StreamUnavailableError (poll instead) / StreamAuthError."""
    try:
        import websockets
    except ImportError as exc:  # pragma: no cover
        raise StreamUnavailableError(
            "the stream client needs the `websockets` package: pip install 'ellipsis-dev[stream]'"
        ) from exc

    cursor = after_seq
    ever_received_frame = False
    attempt = 0
    last_status_word = ""
    last_exit_status: str | None = None

    async def emit(frame: frames.StreamFrame) -> None:
        nonlocal ever_received_frame, attempt, cursor
        nonlocal last_status_word, last_exit_status
        ever_received_frame = True
        # A delivered frame proves this connection works — reset the
        # consecutive-failure counter.
        attempt = 0
        if isinstance(frame, frames.RecordsAppendFrame):
            for record in frame.records:
                if record.feed_seq is not None:
                    cursor = max(cursor, record.feed_seq)
        elif isinstance(frame, (frames.SnapshotFrame, frames.SessionFrame)):
            last_status_word = session_status_word(frame.session)
            last_exit_status = frame.session.exit_status
        result = on_frame(frame)
        if result is not None:
            await result

    while True:
        close_code: int | None = None
        failure = ""
        try:
            async with websockets.connect(
                _ws_url(base_url, session_id, cursor),
                additional_headers={"Authorization": f"Bearer {api_key}"},
            ) as socket:
                while True:
                    data = await asyncio.wait_for(
                        socket.recv(), timeout=HEARTBEAT_TIMEOUT_SECONDS
                    )
                    frame = parse_frame(data)
                    if frame is None:
                        continue
                    await emit(frame)
                    if isinstance(frame, frames.DoneFrame):
                        return StreamOutcome(
                            "done",
                            status=last_status_word,
                            exit_status=last_exit_status,
                        )
                    if isinstance(frame, frames.ErrorFrame):
                        return StreamOutcome("error", message=frame.message)
        except asyncio.CancelledError:
            return StreamOutcome("aborted")
        except asyncio.TimeoutError:
            failure = "heartbeat timeout"
        except websockets.ConnectionClosed as exc:
            close_code = exc.code
            failure = f"stream closed (code {exc.code})"
        except OSError as exc:
            failure = str(exc)
        except websockets.WebSocketException as exc:
            failure = str(exc)

        attempt += 1
        decision = decide_reconnect(
            close_kind=classify_close_code(close_code)
            if close_code is not None
            else None,
            ever_received_frame=ever_received_frame,
            attempt=attempt,
            max_reconnects=max_reconnects,
        )
        if decision.action == "fail-auth":
            raise StreamAuthError("not authorized to stream this session")
        if decision.action == "fallback":
            raise StreamUnavailableError(failure or "stream unavailable")
        await asyncio.sleep(decision.delay_seconds)


__all__ = [
    "SESSION_STREAM_PROTOCOL_VERSION",
    "ReconnectDecision",
    "StreamAuthError",
    "StreamOutcome",
    "StreamUnavailableError",
    "classify_close_code",
    "decide_reconnect",
    "next_reconnect_delay_seconds",
    "parse_frame",
    "session_status_word",
    "stream_query",
    "stream_session",
]
