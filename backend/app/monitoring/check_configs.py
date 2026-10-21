"""Per-check-type configuration schemas.

`config` (non-secret, returned by the API) and `secrets` (write-only, stored encrypted) are
validated separately so credentials never appear in API responses or logs.
"""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.enums import CheckType

_READ_ONLY_QUERY = re.compile(r"^\s*(select|show|with|values|explain)\b", re.IGNORECASE)


class _Cfg(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _validate_port(v: int) -> int:
    if not 1 <= v <= 65535:
        raise ValueError("port must be between 1 and 65535")
    return v


class HostPort(_Cfg):
    host: str = Field(min_length=1, max_length=253)
    port: int

    @field_validator("port")
    @classmethod
    def _port(cls, v: int) -> int:
        return _validate_port(v)


def _status_spec(v: Any) -> list[str]:
    out = []
    for item in v or []:
        s = str(item).strip()
        if not re.fullmatch(r"[1-5]\d\d(-[1-5]\d\d)?|[1-5]xx", s):
            raise ValueError(f"invalid status specification {s!r} (use 200, 200-299 or 2xx)")
        out.append(s)
    return out or ["200-399"]


def status_matches(code: int, specs: list[str]) -> bool:
    for s in specs:
        if s.endswith("xx"):
            if str(code)[0] == s[0]:
                return True
        elif "-" in s:
            lo, hi = s.split("-")
            if int(lo) <= code <= int(hi):
                return True
        elif int(s) == code:
            return True
    return False


class JsonAssertion(_Cfg):
    path: str = Field(min_length=1, max_length=200, description="Dotted path, e.g. data.status or items.0.id")
    op: Literal["eq", "ne", "exists", "contains", "gt", "lt"] = "eq"
    value: Any = None


class HttpConfig(_Cfg):
    url: str = Field(max_length=2048)
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = Field(default=None, max_length=65536)
    expected_status: list[str] = Field(default_factory=lambda: ["200-399"])
    follow_redirects: bool = True
    max_redirects: int = Field(default=5, ge=0, le=10)
    keyword: str | None = Field(default=None, max_length=500)
    keyword_absent: bool = False  # true → fail if keyword IS present
    keyword_case_sensitive: bool = False
    expected_headers: dict[str, str] = Field(default_factory=dict)  # name → regex
    json_assertions: list[JsonAssertion] = Field(default_factory=list, max_length=20)
    verify_tls: bool = True
    degraded_threshold_ms: float | None = Field(default=None, gt=0)
    ssl_check: bool = True  # record certificate expiry for https URLs
    ssl_alert_days: list[int] | None = None  # override org default thresholds
    ip_version: Literal["any", "4", "6"] = "any"

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        parts = urlsplit(v.strip())
        if parts.scheme not in ("http", "https"):
            raise ValueError("URL must use http or https")
        if not parts.hostname:
            raise ValueError("URL must include a host")
        if parts.username or parts.password:
            raise ValueError("credentials in URLs are not allowed; use the auth secret fields")
        return v.strip()

    @field_validator("expected_status", mode="before")
    @classmethod
    def _statuses(cls, v: Any) -> list[str]:
        return _status_spec(v)

    @field_validator("headers")
    @classmethod
    def _headers(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 30:
            raise ValueError("too many headers")
        for k, val in v.items():
            if not re.fullmatch(r"[A-Za-z0-9\-]{1,100}", k) or "\n" in val or "\r" in val:
                raise ValueError(f"invalid header {k!r}")
            if k.lower() in ("host", "authorization", "cookie", "proxy-authorization"):
                raise ValueError(f"header {k} must be configured via secret fields")
        return v

    @field_validator("expected_headers")
    @classmethod
    def _exp_headers(cls, v: dict[str, str]) -> dict[str, str]:
        for pattern in v.values():
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ValueError(f"invalid regex {pattern!r}: {exc}") from exc
        return v

    @property
    def host(self) -> str:
        return urlsplit(self.url).hostname or ""


class HttpSecrets(_Cfg):
    basic_username: str | None = None
    basic_password: str | None = None
    bearer_token: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)  # e.g. API keys sent as headers


class TcpConfig(HostPort):
    send: str | None = Field(default=None, max_length=1024)
    expect: str | None = Field(default=None, max_length=1024)
    use_tls: bool = False


class IcmpConfig(_Cfg):
    host: str = Field(min_length=1, max_length=253)
    count: int = Field(default=4, ge=1, le=20)
    packet_loss_warning: float = Field(default=20, ge=0, le=100)
    packet_loss_critical: float = Field(default=100, ge=0, le=100)
    latency_warning_ms: float | None = Field(default=None, gt=0)


class DnsConfig(_Cfg):
    name: str = Field(min_length=1, max_length=253)
    record_type: Literal["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV", "CAA", "PTR"] = "A"
    nameserver: str | None = None  # IP; default = system resolver
    expected_values: list[str] = Field(default_factory=list)
    match: Literal["any", "all", "exact"] = "any"


class TlsConfig(HostPort):
    port: int = 443
    server_name: str | None = None
    ssl_alert_days: list[int] | None = None
    fail_on_invalid: bool = True


class SmtpConfig(HostPort):
    port: int = 25
    starttls: bool = False
    ehlo_name: str = "emonitor.local"


class SshConfig(HostPort):
    port: int = 22
    expect_banner: str = "SSH-2.0"


class DbConfig(HostPort):
    database: str | None = Field(default=None, max_length=128)
    username: str | None = Field(default=None, max_length=128)
    tls: Literal["disable", "prefer", "require"] = "prefer"
    query: str | None = Field(default=None, max_length=2000)
    expected_value: str | None = None
    latency_warning_ms: float | None = Field(default=None, gt=0)

    @field_validator("query")
    @classmethod
    def _readonly(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        body = v.strip().rstrip(";")
        if ";" in body:
            raise ValueError("only a single statement is allowed")
        if not _READ_ONLY_QUERY.match(body):
            raise ValueError("only read-only queries (SELECT/SHOW/WITH/VALUES/EXPLAIN) are allowed")
        if re.search(r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|lock|"
                     r"pg_sleep|sleep|benchmark|into\s+outfile|load_file|dblink|lo_import)\b", body, re.IGNORECASE):
            raise ValueError("query contains a disallowed keyword")
        return body


class PostgresConfig(DbConfig):
    port: int = 5432


class MysqlConfig(DbConfig):
    port: int = 3306


class RedisConfig(HostPort):
    port: int = 6379
    tls: bool = False
    db: int = Field(default=0, ge=0, le=15)
    latency_warning_ms: float | None = Field(default=None, gt=0)
    username: str | None = None


class DbSecrets(_Cfg):
    password: str | None = None


class SnmpConfig(HostPort):
    port: int = 161
    version: Literal["1", "2c", "3"] = "2c"
    max_interfaces: int = Field(default=64, ge=1, le=512)
    collect_interfaces: bool = True
    # v3 non-secret parameters
    v3_username: str | None = None
    v3_auth_protocol: Literal["none", "md5", "sha", "sha256", "sha512"] = "sha"
    v3_priv_protocol: Literal["none", "des", "aes128", "aes256"] = "aes128"
    v3_security_level: Literal["noAuthNoPriv", "authNoPriv", "authPriv"] = "authPriv"

    @model_validator(mode="after")
    def _v3(self) -> SnmpConfig:
        if self.version == "3" and not self.v3_username:
            raise ValueError("SNMPv3 requires v3_username")
        return self


class DomainConfig(_Cfg):
    domain: str = Field(min_length=3, max_length=253, description="Registrable domain, e.g. example.co.tz")
    alert_days: list[int] | None = None  # override org defaults (default 60/30/14/7/1)

    @field_validator("domain")
    @classmethod
    def _domain(cls, v: str) -> str:
        v = v.strip().lower().rstrip(".")
        if v.startswith(("http://", "https://")):
            v = (urlsplit(v).hostname or "")
        if not re.fullmatch(r"(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}", v):
            raise ValueError("enter a domain name such as example.com or example.co.tz")
        return v

    @field_validator("alert_days")
    @classmethod
    def _days(cls, v: list[int] | None) -> list[int] | None:
        if v is not None and (len(v) > 10 or any(d < 0 or d > 365 for d in v)):
            raise ValueError("alert_days: up to 10 values between 0 and 365")
        return v


class SnmpSecrets(_Cfg):
    community: str | None = None
    v3_auth_key: str | None = None
    v3_priv_key: str | None = None


CONFIG_MODELS: dict[str, type[_Cfg]] = {
    CheckType.HTTP: HttpConfig,
    CheckType.TCP: TcpConfig,
    CheckType.ICMP: IcmpConfig,
    CheckType.DNS: DnsConfig,
    CheckType.TLS: TlsConfig,
    CheckType.SMTP: SmtpConfig,
    CheckType.SSH: SshConfig,
    CheckType.POSTGRES: PostgresConfig,
    CheckType.MYSQL: MysqlConfig,
    CheckType.REDIS: RedisConfig,
    CheckType.SNMP: SnmpConfig,
    CheckType.DOMAIN: DomainConfig,
}

SECRET_MODELS: dict[str, type[_Cfg]] = {
    CheckType.HTTP: HttpSecrets,
    CheckType.POSTGRES: DbSecrets,
    CheckType.MYSQL: DbSecrets,
    CheckType.REDIS: DbSecrets,
    CheckType.SNMP: SnmpSecrets,
}


def parse_config(check_type: str, config: dict[str, Any]) -> _Cfg:
    model = CONFIG_MODELS.get(check_type)
    if not model:
        raise ValueError(f"unsupported check type {check_type!r}")
    return model.model_validate(config)


def parse_secrets(check_type: str, secrets: dict[str, Any] | None) -> _Cfg | None:
    model = SECRET_MODELS.get(check_type)
    if model is None:
        if secrets:
            raise ValueError(f"check type {check_type} does not accept secrets")
        return None
    return model.model_validate(secrets or {})


def target_host(check_type: str, cfg: _Cfg) -> str:
    if isinstance(cfg, HttpConfig):
        return cfg.host
    if isinstance(cfg, DnsConfig):
        return cfg.nameserver or ""
    if isinstance(cfg, DomainConfig):
        return ""  # queried at IANA-listed registry RDAP/WHOIS servers, not at a user-chosen host
    return getattr(cfg, "host", "")
