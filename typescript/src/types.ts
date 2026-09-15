// The SDK's public type surface. Everything here is re-exported from the
// generated modules — the frame types from the frame DTOs' JSON Schema, the
// REST types from the OpenAPI document — never hand-written, so the types
// cannot drift from the server (the backend's test suite pins the committed
// schema documents to the models).

import type { components } from './generated/openapi';
export type {
  CollectionStreamFrame,
  SessionListStreamMessage,
  AgentListStreamMessage,
  CollectionStreamHeartbeat,
  SandboxSnapshotFrame,
  SandboxUpdateFrame,
} from './generated/collection-frames';
import type {
  ClaudeSessionRecord,
  CodexSessionRecord,
  CodexAppServerSessionRecord,
  PlatformSessionRecord,
  ClaudeNativeSessionRecord,
  RecordsAppendFrame,
  SessionStreamFrame,
} from './generated/frames';

// Every frame, platform variant, and native payload model is public.
export type * from './generated/frames';

// `kind` selects the producer's typed data or an opaque unknown record.
// Platform records then narrow on `record_type`; native events use their tags.
export type SessionRecord = RecordsAppendFrame['records'][number];
export type LifecycleSessionRecord = PlatformSessionRecord;
export type ClaudeNativeEvent = ClaudeNativeSessionRecord['payload'];

// The typed payloads, named off the envelope so they stay pinned to it.
export type SdkRecord = ClaudeSessionRecord['payload'];
export type SdkAssistantRecord = Extract<SdkRecord, { kind: 'assistant' }>;
export type SdkUserRecord = Extract<SdkRecord, { kind: 'user' }>;
export type SdkSystemRecord = Extract<SdkRecord, { kind: 'system' }>;
export type SdkResultRecord = Extract<SdkRecord, { kind: 'result' }>;
export type SdkRateLimitRecord = Extract<SdkRecord, { kind: 'rate_limit' }>;
export type SdkContentBlock = NonNullable<
  SdkAssistantRecord['content']
>[number];
export type CodexEvent = CodexSessionRecord['payload'];
export type CodexAppServerEvent = CodexAppServerSessionRecord['payload'];
export type CodexItem = Extract<CodexEvent, { type: 'item.completed' }>['item'];

// The transport ignores unknown frame types before invoking callbacks.
// Known frames retain literal tags for narrowing.
export type StreamFrame = SessionStreamFrame;

// REST DTOs of the SDK's public surface (§4), by OpenAPI component name.
export type SendSessionMessageRequest =
  components['schemas']['SendSessionMessageRequest'];
export type SessionRecordsListResponse =
  components['schemas']['SessionRecordsListResponse'];
export type SessionExecution = components['schemas']['SessionExecution'];
export type ExecutionResult = components['schemas']['ExecutionResult'];
export type SessionExecutionsListResponse =
  components['schemas']['SessionExecutionsListResponse'];
export type SessionResponse = components['schemas']['SessionResponse'];
export type UpdateSessionRequest =
  components['schemas']['UpdateSessionRequest'];
export type SessionMessageResponse =
  components['schemas']['SessionMessageResponse'];
export type SessionsListResponse =
  components['schemas']['SessionsListResponse'];

// The reviews surface. A review IS a run, and `stages[].session_id` is where a
// client streams.
export type CreateReviewRequest = components['schemas']['CreateReviewRequest'];
export type Review = components['schemas']['Review'];
export type ReviewsListResponse = components['schemas']['ReviewsListResponse'];
export type ReviewScope = components['schemas']['ReviewScope'];
export type ReviewScopeKind = components['schemas']['ReviewScopeKind'];
export type ResolvedReviewScope = components['schemas']['ResolvedReviewScope'];
export type ReviewCounters = components['schemas']['ReviewCounters'];
export type ReviewStage = components['schemas']['ReviewStage'];
export type ReviewedCommit = components['schemas']['ReviewedCommit'];
export type ReviewConfiguration = components['schemas']['ReviewConfiguration'];
export type ReviewRequester = components['schemas']['ReviewRequester'];
// `review.findings[]`. A superset of the bare reviewer finding — it also carries
// the pipeline's verdict — so the old `Finding` name stays an alias for it rather
// than breaking every consumer.
export type ReviewFinding = components['schemas']['ReviewFinding'];
export type Finding = ReviewFinding;

export type { paths, components } from './generated/openapi';
