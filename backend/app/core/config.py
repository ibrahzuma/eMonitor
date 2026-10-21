"""Application settings loaded from environment variables (prefix ``EMONITOR_``) or ``.env``."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="EMONITOR_",
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "test", "staging", "production"] = "development"
    app_name: str = "eMonitor"
    public_base_url: str = "http://localhost:5173"
    api_prefix: str = "/api/v1"
    log_level: str = "INFO"
    log_json: bool = True

    # Secrets — must be provided in production (see .env.example).
    secret_key: SecretStr = SecretStr("dev-insecure-secret-key-change-me-0000000000")
    encryption_key: SecretStr = SecretStr("")  # Fernet key (urlsafe base64, 32 bytes)

    # PostgreSQL
    database_url: str = "postgresql+asyncpg://emonitor:emonitor@localhost:5432/emonitor"
    database_pool_size: int = 10
    database_max_overflow: int = 20
    database_echo: bool = False

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str | None = None
    celery_result_backend: str | None = None

    # ClickHouse
    clickhouse_host: str = "localhost"
    clickhouse_port: int = 8123
    clickhouse_user: str = "emonitor"
    clickhouse_password: SecretStr = SecretStr("")
    clickhouse_database: str = "emonitor"
    clickhouse_secure: bool = False
    clickhouse_query_timeout_s: int = 15
    clickhouse_max_rows: int = 10_000

    # Auth / sessions
    access_token_minutes: int = 15
    refresh_token_days: int = 14
    session_idle_minutes_default: int = 120
    password_reset_minutes: int = 30
    cookie_secure: bool = True
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])
    trusted_proxies: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["127.0.0.1", "::1"])

    # Rate limits ("count/seconds")
    rate_limit_login: str = "10/300"
    rate_limit_sensitive: str = "20/300"
    rate_limit_api: str = "600/60"
    rate_limit_enroll: str = "20/3600"
    rate_limit_agent_download: str = "120/300"

    # Ingestion / backpressure
    ingest_stream_maxlen: int = 200_000
    ingest_high_watermark: int = 150_000
    ingest_batch_size: int = 5_000
    ingest_flush_seconds: float = 1.0
    max_metrics_per_request: int = 5_000
    max_logs_per_request: int = 5_000
    max_log_message_bytes: int = 16_384

    # Monitoring
    scheduler_tick_seconds: float = 1.0
    scheduler_batch_size: int = 500
    check_queue_max_depth: int = 50_000
    min_check_interval_seconds: int = 10
    agent_timeout_seconds_default: int = 180
    allow_private_targets: bool = True  # still requires the org scope to list the CIDR
    http_max_body_bytes: int = 1_048_576
    probe_user_agent: str = "eMonitor-Probe/1.0"

    # SMTP (platform email: password reset, email channel default)
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_starttls: bool = True
    smtp_from: str = "eMonitor <noreply@example.com>"

    # Development only: run scheduler/workers inside the API process (refused in production)
    dev_inline_workers: bool = False

    @field_validator("cors_origins", "trusted_proxies", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            if v.strip().startswith("["):
                import json

                return json.loads(v)
            return [x.strip() for x in v.split(",") if x.strip()]
        return v

    @property
    def broker_url(self) -> str:
        return self.celery_broker_url or self.redis_url

    @property
    def result_backend(self) -> str:
        return self.celery_result_backend or self.redis_url

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def validate_for_production(self) -> None:
        """Refuse to start in production with insecure defaults."""
        if not self.is_production:
            return
        problems = []
        if "dev-insecure" in self.secret_key.get_secret_value() or len(self.secret_key.get_secret_value()) < 32:
            problems.append("EMONITOR_SECRET_KEY must be a random value of at least 32 characters")
        if not self.encryption_key.get_secret_value():
            problems.append("EMONITOR_ENCRYPTION_KEY must be set (Fernet key)")
        if self.dev_inline_workers:
            problems.append("EMONITOR_DEV_INLINE_WORKERS must not be enabled in production")
        if not self.cookie_secure:
            problems.append("EMONITOR_COOKIE_SECURE must be true in production")
        if problems:
            raise RuntimeError("Insecure configuration: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
