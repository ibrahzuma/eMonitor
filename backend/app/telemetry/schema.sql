-- eMonitor ClickHouse schema. Applied by `python -m app.cli clickhouse-migrate` (idempotent).
-- {db} is substituted with EMONITOR_CLICKHOUSE_DATABASE by the migrator (identifier, validated).
-- Statements are separated by lines containing only ';;'.

CREATE TABLE IF NOT EXISTS {db}.metrics
(
    ts             DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    org_id         UUID,
    resource_id    UUID,
    metric         LowCardinality(String),
    instance       LowCardinality(String) DEFAULT '',
    value          Float64 CODEC(Gorilla, ZSTD(1)),
    source         LowCardinality(String) DEFAULT 'agent',
    retention_days UInt16 DEFAULT 90
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (org_id, resource_id, metric, instance, ts)
TTL toDateTime(ts) + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192
;;
CREATE TABLE IF NOT EXISTS {db}.check_results
(
    scheduled_at   DateTime64(3, 'UTC'),
    executed_at    DateTime64(3, 'UTC'),
    org_id         UUID,
    check_id       UUID,
    resource_id    UUID,
    check_type     LowCardinality(String),
    status         LowCardinality(String),       -- up | degraded | down | unknown | skipped
    latency_ms     Nullable(Float64),
    dns_ms         Nullable(Float64),
    connect_ms     Nullable(Float64),
    tls_ms         Nullable(Float64),
    ttfb_ms        Nullable(Float64),
    http_status    UInt16 DEFAULT 0,
    message        String,
    details        String DEFAULT '{}',           -- JSON
    in_maintenance UInt8 DEFAULT 0,
    worker         LowCardinality(String) DEFAULT '',
    retention_days UInt16 DEFAULT 400
)
ENGINE = ReplacingMergeTree(executed_at)          -- duplicate deliveries of a slot collapse
PARTITION BY toYYYYMM(scheduled_at)
ORDER BY (org_id, check_id, scheduled_at)
TTL toDateTime(scheduled_at) + toIntervalDay(retention_days)
;;
CREATE TABLE IF NOT EXISTS {db}.logs
(
    ts             DateTime64(6, 'UTC') CODEC(Delta, ZSTD(1)),
    id             UUID,
    org_id         UUID,
    resource_id    UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
    host           LowCardinality(String) DEFAULT '',
    application    LowCardinality(String) DEFAULT '',
    service        LowCardinality(String) DEFAULT '',
    source         LowCardinality(String) DEFAULT '',
    environment    LowCardinality(String) DEFAULT '',
    severity       LowCardinality(String) DEFAULT 'info',
    severity_num   UInt8 DEFAULT 6,               -- syslog numbering: 0 emerg … 7 debug
    message        String CODEC(ZSTD(3)),
    trace_id       String DEFAULT '',
    attributes     Map(LowCardinality(String), String),
    ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3),
    retention_days UInt16 DEFAULT 14,
    INDEX idx_message_tokens lower(message) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
    INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (org_id, ts, id)
TTL toDateTime(ts) + toIntervalDay(retention_days)
SETTINGS index_granularity = 8192
;;
CREATE TABLE IF NOT EXISTS {db}.events
(
    ts          DateTime64(3, 'UTC'),
    id          UUID,
    org_id      UUID,
    resource_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
    kind        LowCardinality(String),        -- status_change | incident | agent | maintenance | check
    severity    LowCardinality(String) DEFAULT 'info',
    title       String,
    message     String DEFAULT '',
    data        String DEFAULT '{}'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (org_id, ts, id)
TTL toDateTime(ts) + toIntervalDay(400)
;;
CREATE TABLE IF NOT EXISTS {db}.schema_migrations
(
    version    UInt32,
    applied_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree
ORDER BY version
