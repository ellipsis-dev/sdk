"""The hand-written transport layer: base URL, bearer auth, retries, errors.

Written once; its size is independent of the route count. The generated core
calls `request()` with an operation's method/path/params/body and a response
model; everything HTTP lives here.
"""

import random
import time
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel
from pydantic_core import to_jsonable_python

from ._errors import APIError, TransportError, api_error_for

DEFAULT_BASE_URL = "https://api.ellipsis.dev"
DEFAULT_TIMEOUT_SECONDS = 60.0
# 429 and 5xx are retried with exponential backoff + jitter; everything else
# raises immediately. Only idempotent-safe by the API's own semantics: every
# retried status means the request was not applied.
RETRY_STATUSES = frozenset({429, 502, 503, 504})
MAX_RETRIES = 2

T = TypeVar("T", bound=BaseModel)


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


def build_body(body: BaseModel) -> Any:
    """Serialize a request model: aliases honored (`for_` -> `for`), omitted
    optionals excluded so the server applies its own defaults."""
    return body.model_dump(mode="json", by_alias=True, exclude_none=True)


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
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        self._max_retries = max_retries
        # Public so the stream client / sugar can reuse the credential.
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
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
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        self._max_retries = max_retries
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
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
