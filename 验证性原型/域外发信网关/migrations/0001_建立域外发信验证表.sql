PRAGMA foreign_keys = ON;

CREATE TABLE send_operations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  mime_size INTEGER NOT NULL,
  effective_limit INTEGER NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT,
  payload_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE recipient_deliveries (
  operation_id TEXT NOT NULL REFERENCES send_operations(id),
  recipient TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_event_at INTEGER,
  complaint INTEGER NOT NULL DEFAULT 0,
  detail_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, recipient)
);

CREATE TABLE provider_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  provider_event_type TEXT NOT NULL,
  normalized_state TEXT,
  occurred_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE mock_provider_deliveries (
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(provider, provider_message_id)
);

CREATE UNIQUE INDEX mock_provider_idempotency_idx
  ON mock_provider_deliveries(provider, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
