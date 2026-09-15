"""Transparent cursor pagination for the generated list methods.

The spec says which routes paginate (a `next_cursor` in the response schema);
the generated core wraps those responses in a page object. Iterating walks
every page; the object also exposes the underlying response (`next_cursor`,
`has_more`, and the page's items) for a caller who wants exactly one page.
"""

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from typing import Any, Generic, TypeVar

from pydantic import BaseModel

ItemT = TypeVar("ItemT")
ResponseT = TypeVar("ResponseT", bound=BaseModel)


class SyncPage(Generic[ItemT, ResponseT]):
    def __init__(
        self,
        response: ResponseT,
        items_attr: str,
        fetch_next: "Callable[[str], SyncPage[ItemT, ResponseT]]",
    ) -> None:
        self._response = response
        self._items_attr = items_attr
        self._fetch_next = fetch_next

    @property
    def response(self) -> ResponseT:
        """The current page's raw response envelope."""
        return self._response

    @property
    def items(self) -> list[ItemT]:
        return list(getattr(self._response, self._items_attr))

    @property
    def has_more(self) -> bool:
        return bool(getattr(self._response, "has_more", False))

    @property
    def next_cursor(self) -> str | None:
        return getattr(self._response, "next_cursor", None)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)

    def __iter__(self) -> Iterator[ItemT]:
        page: SyncPage[ItemT, ResponseT] = self
        while True:
            yield from page.items
            cursor = page.next_cursor
            if not page.has_more or cursor is None:
                return
            page = self._fetch_next(cursor)


class AsyncPage(Generic[ItemT, ResponseT]):
    def __init__(
        self,
        response: ResponseT,
        items_attr: str,
        fetch_next: "Callable[[str], Awaitable[AsyncPage[ItemT, ResponseT]]]",
    ) -> None:
        self._response = response
        self._items_attr = items_attr
        self._fetch_next = fetch_next

    @property
    def response(self) -> ResponseT:
        """The current page's raw response envelope."""
        return self._response

    @property
    def items(self) -> list[ItemT]:
        return list(getattr(self._response, self._items_attr))

    @property
    def has_more(self) -> bool:
        return bool(getattr(self._response, "has_more", False))

    @property
    def next_cursor(self) -> str | None:
        return getattr(self._response, "next_cursor", None)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)

    async def __aiter__(self) -> AsyncIterator[ItemT]:
        page: AsyncPage[ItemT, ResponseT] = self
        while True:
            for item in page.items:
                yield item
            cursor = page.next_cursor
            if not page.has_more or cursor is None:
                return
            page = await self._fetch_next(cursor)
