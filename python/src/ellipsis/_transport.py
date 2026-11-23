"""The hand-written transport layer: base URL, bearer auth, retries, errors.

Written once; its size is independent of the route count. The generated core
calls `request()` with an operation's method/path/params/body and a response
model; everything HTTP lives here.
"""

import os
import random
import time
import uuid
from typing import Any, Literal, TypeVar, get_origin

import httpx
from pydantic import BaseModel, RootModel
from pydantic_core import to_jsonable_python

from ._errors import APIError, EllipsisError, TransportError, api_error_for

DEFAULT_BASE_URL = "https://api.ellipsis.dev"
# Read when the caller passes no base_url. Session VMs set it, so code running
# inside a session reaches the API without configuration.
BASE_URL_ENV = "ELLIPSIS_API_BASE_URL"
# Read when the caller passes no api_key, the variable the CLI reads too.
API_KEY_ENV = "ELLIPSIS_API_TOKEN"
DEFAULT_TIMEOUT_SECONDS = 60.0
# 429 and 5xx are retried with exponential backoff + jitter; everything else
# raises immediately. Only idempotent-safe by the API's own semantics: every
# retried status means the request was not applied.
RETRY_STATUSES = frozenset({429, 502, 503, 504})
MAX_RETRIES = 2

T = TypeVar("T", bound=BaseModel)


class JsonObject(RootModel[dict[str, Any]]):
    """A JSON object response whose keys are defined by the customer."""


def _query_value(value: Any) -> Any:
    if isinstance(value, bool):
        return "true" if value else "false"
    return to_jsonable_python(value)


def build_query(params: dict[str, Any]) -> list[tuple[str, Any]]:
    """Drop omitted params; explode lists into repeated keys (FastAPI's
    convention for `Query` list params)."""
    query: list[tuple[str, Any]] = []
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            query.extend((key, _query_value(v)) for v in value)
        else:
            query.append((key, _query_value(value)))
    return query


class NotGiven:
    """The default of an optional argument you did not pass. A field left at
    `NOT_GIVEN` is not sent, so the server keeps or defaults it. `None` is
    sent as `null`."""

    _instance: "NotGiven | None" = None

    def __new__(cls) -> "NotGiven":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "NOT_GIVEN"


NOT_GIVEN = NotGiven()


def _is_fixed(annotation: Any) -> bool:
    return get_origin(annotation) is Literal


def _only_what_was_set(value: Any, dumped: Any) -> Any:
    if isinstance(value, RootModel):
        return _only_what_was_set(value.root, dumped)
    if isinstance(value, BaseModel) and isinstance(dumped, dict):
        fields = type(value).model_fields
        names = {
            field.serialization_alias or field.alias or name: name
            for name, field in fields.items()
        }
        kept: dict[str, Any] = {}
        for key, item in dumped.items():
            name = names.get(key)
            if name is None:
                kept[key] = item
            elif name in value.model_fields_set or _is_fixed(fields[name].annotation):
                kept[key] = _only_what_was_set(getattr(value, name), item)
        return kept
    if (
        isinstance(value, (list, tuple))
        and isinstance(dumped, list)
        and len(value) == len(dumped)
    ):
        return [_only_what_was_set(item, out) for item, out in zip(value, dumped)]
    if isinstance(value, dict) and isinstance(dumped, dict):
        return {
            key: _only_what_was_set(value.get(key), item)
            for key, item in dumped.items()
        }
    return dumped


def build_body(body: BaseModel) -> Any:
    """Serialize a request model: aliases honored (`for_` -> `for`). Only the
    fields you set are sent, so the server keeps or defaults the rest, and a
    field you set to `None` is sent as `null`. A fixed value, such as a
    model's `kind`, is always sent."""
    return _only_what_was_set(body, body.model_dump(mode="json", by_alias=True))


def new_idempotency_key() -> str:
    """A fresh key for a request that takes `idempotency_key`. The generated
    client makes one per call when the caller sets none, so the transport's
    retries of that call reuse it and the server applies the call once."""
    return uuid.uuid4().hex


def resolve_base_url(base_url: str | None) -> str:
    """The explicit base URL, else ELLIPSIS_API_BASE_URL, else the default."""
    return (base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")


def resolve_api_key(api_key: str | None) -> str:
    """The explicit API key, else ELLIPSIS_API_TOKEN. A client with neither
    cannot make a request, so it is refused when it is built."""
    resolved = api_key or os.environ.get(API_KEY_ENV)
    if not resolved:
        raise EllipsisError(f"No API key. Pass api_key or set {API_KEY_ENV}.")
    return resolved


def _backoff_seconds(attempt: int, retry_after: str | None) -> float:
    if retry_after is not None:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass
    return (2.0**attempt) * 0.5 + random.random() * 0.25


class Transport:
    """Sync transport over httpx. One instance per client; owns the pool."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        self._max_retries = max_retries
        # Public so the stream client / sugar can reuse the credential.
        self.base_url = resolve_base_url(base_url)
        self.api_key = resolve_api_key(api_key)
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )

    def close(self) -> None:
        self._client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        response_model: type[T] | None,
        query: list[tuple[str, Any]] | None = None,
        json_body: Any = None,
    ) -> T | None:
        for attempt in range(self._max_retries + 1):
            try:
                response = self._client.request(
                    method, path, params=query or None, json=json_body
                )
            except httpx.HTTPError as exc:
                if attempt < self._max_retries:
                    time.sleep(_backoff_seconds(attempt, None))
                    continue
                raise TransportError(str(exc)) from exc
            if response.status_code in RETRY_STATUSES and attempt < self._max_retries:
                time.sleep(
                    _backoff_seconds(attempt, response.headers.get("retry-after"))
                )
                continue
            return _finish(response, response_model)
        raise AssertionError("unreachable")


class AsyncTransport:
    """The async twin, byte-for-byte the same semantics over httpx.AsyncClient."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        self._max_retries = max_retries
        self.base_url = resolve_base_url(base_url)
        self.api_key = resolve_api_key(api_key)
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        response_model: type[T] | None,
        query: list[tuple[str, Any]] | None = None,
        json_body: Any = None,
    ) -> T | None:
        import asyncio

        for attempt in range(self._max_retries + 1):
            try:
                response = await self._client.request(
                    method, path, params=query or None, json=json_body
                )
            except httpx.HTTPError as exc:
                if attempt < self._max_retries:
                    await asyncio.sleep(_backoff_seconds(attempt, None))
                    continue
                raise TransportError(str(exc)) from exc
            if response.status_code in RETRY_STATUSES and attempt < self._max_retries:
                await asyncio.sleep(
                    _backoff_seconds(attempt, response.headers.get("retry-after"))
                )
                continue
            return _finish(response, response_model)
        raise AssertionError("unreachable")


def _finish(response: httpx.Response, response_model: type[T] | None) -> T | None:
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            body = response.text
        raise api_error_for(response.status_code, body)
    if response.status_code == 204 or response_model is None:
        return None
    return response_model.model_validate(response.json())


__all__ = [
    "APIError",
    "AsyncTransport",
    "Transport",
    "TransportError",
    "build_body",
    "build_query",
]
