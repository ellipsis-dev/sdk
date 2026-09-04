// The SDK's public type surface. Everything here is re-exported from the
// generated modules — the frame types from the frame DTOs' JSON Schema, the
// REST types from the OpenAPI document — never hand-written, so the types
// cannot drift from the server (the backend's test suite pins the committed
// schema documents to the models).

import type { components } from './generated/openapi';
import type {
  ClaudeSessionRecord,
  CodexSessionRecord,
  LifecycleSessionRecord,
  SessionStreamFrame,
} from './generated/frames';

export type {
  // The frames (protocol §3.3).
  SessionStreamFrame,
  SnapshotFrame,
  RecordsAppendFrame,
  SessionFrame,
  DeltaFrame,
  HeartbeatFrame,
  DoneFrame,
  ErrorFrame,
  // The resources the frames carry (§3.6 stable envelopes).
  Session,
  ClaudeSessionRecord,
  CodexSessionRecord,
  LifecycleSessionRecord,
  SessionMessage,
  SessionSurface,
  SessionPrompting,
  GithubAccountSnippet,
  SessionGit,
  TokensInfo,
  // The closed vocabularies (a new value here is a contract change).
  SessionStatus,
  SessionExitStatus,
  SessionSource,
  SessionState,
  SessionLiveness,
  PromptBlockedReason,
  SessionMessageStatus,
  AttributionType,
  BudgetSource,
  GithubAccountType,
  Harness,
  ParentKind,
} from './generated/frames';

// One session record, discriminated by `record_format` (then by
// `payload.kind` for Claude and `payload.type` for Codex). The formats are an
// Ellipsis contract: a payload change ships as a new format token.
export type SessionRecord =
  ClaudeSessionRecord | CodexSessionRecord | LifecycleSessionRecord;

// The typed payloads, named off the envelope so they stay pinned to it.
export type SdkRecord = ClaudeSessionRecord['payload'];
export type SdkAssistantRecord = Extract<SdkRecord, { kind: 'assistant' }>;
export type SdkUserRecord = Extract<SdkRecord, { kind: 'user' }>;
export type SdkSystemRecord = Extract<SdkRecord, { kind: 'system' }>;
export type SdkResultRecord = Extract<SdkRecord, { kind: 'result' }>;
export type SdkRateLimitRecord = Extract<SdkRecord, { kind: 'rate_limit' }>;
export type SdkContentBlock = SdkAssistantRecord['content'][number];
export type CodexEvent = CodexSessionRecord['payload'];
export type CodexItem = Extract<CodexEvent, { type: 'item.completed' }>['item'];

// Forward compatibility (§3.6): unknown frame types parse and MUST be ignored
// by renderers — additive server frames are not a protocol break. Consumers
// switch on `frame.type` with a default no-op arm.
export type StreamFrame =
  SessionStreamFrame | { type: string; [key: string]: unknown };

// REST DTOs of the SDK's public surface (§4), by OpenAPI component name.
export type SendSessionMessageRequest =
  components['schemas']['SendSessionMessageRequest'];
export type SessionRecordsListResponse =
  components['schemas']['SessionRecordsListResponse'];
export type SessionResponse = components['schemas']['SessionResponse'];
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
