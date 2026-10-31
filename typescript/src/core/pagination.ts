// Transparent cursor pagination for the generated list methods. The spec says
// which routes paginate (a `next_cursor` in the response schema); iterating a
// Page walks every page, while the object exposes the raw response for a
// caller who wants exactly one.

export interface CursorResponse {
  has_more: boolean;
  next_cursor?: string | null;
}

export class Page<
  ItemT,
  ResponseT extends CursorResponse,
> implements AsyncIterable<ItemT> {
  constructor(
    readonly response: ResponseT,
    private readonly itemsAttr: keyof ResponseT,
    private readonly fetchNext: (
      cursor: string
    ) => Promise<Page<ItemT, ResponseT>>
  ) {}

  get items(): ItemT[] {
    return this.response[this.itemsAttr] as ItemT[];
  }

  get hasMore(): boolean {
    return this.response.has_more;
  }

  get nextCursor(): string | null {
    return this.response.next_cursor ?? null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ItemT> {
    let page: Page<ItemT, ResponseT> = this;
    for (;;) {
      yield* page.items;
      const cursor = page.nextCursor;
      if (!page.hasMore || cursor == null) return;
      page = await this.fetchNext(cursor);
    }
  }
}
