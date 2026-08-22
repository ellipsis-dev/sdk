# @ellipsis-dev/sdk

TypeScript SDK for the [Ellipsis](https://www.ellipsis.dev) agents platform.
Three subpath exports, all dependency-free at runtime:

- **`@ellipsis-dev/sdk`** — generated `/v1` REST types + `EllipsisClient`, a thin
  typed client over an injected `fetchJson`.
- **`@ellipsis-dev/sdk/stream`** — the session stream WebSocket client
  (`streamSession`): protocol negotiation, heartbeat liveness,
  reconnect-with-backoff, and lossless resume via the `after_seq` record
  cursor. Transport is an injected `openSocket`, so the same machinery runs in
  a browser, a terminal, or a server.
- **`@ellipsis-dev/sdk/store`** — `SessionTranscriptStore`
  (`subscribe`/`getSnapshot`, shaped for React's `useSyncExternalStore` but
  framework-free) plus the pure shaping helpers that turn raw session records
  into renderable transcript items and chat turns.

## Types are generated, never hand-written

- `schema/frames.schema.json` — JSON Schema of the WebSocket frames, produced
  from the server's frame models.
- `schema/openapi.v1.json` — the OpenAPI document for the SDK's REST surface.

`pnpm gen` derives `src/generated/` from those documents
(`json-schema-to-typescript` + `openapi-typescript`). CI regenerates and
diffs, and the server's own test suite pins the committed schema documents to
its models, so types cannot drift from the deployed API in either direction.

`test/fixtures/golden_stream.json` is a frame sequence recorded from the real
server stream loop (ids and timestamps normalized); the store's tests replay
it, so client behavior is validated against real emissions, not hand-written
examples.

## Protocol

The stream protocol (frame taxonomy, delivery classes, resume/close-code
contract) is documented at https://www.ellipsis.dev/docs. The compatibility
rule clients must follow: **ignore unknown frame types and unknown
`source`/`record_type`/`kind` values** — additive server changes are not a
protocol break.
