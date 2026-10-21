"""Notification templates rendered in a Jinja2 sandbox (user-editable, so never trusted)."""

from __future__ import annotations

from typing import Any

from jinja2 import StrictUndefined
from jinja2.exceptions import TemplateError
from jinja2.sandbox import SandboxedEnvironment

from app.core.config import get_settings

_env = SandboxedEnvironment(autoescape=False, undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)

DEFAULT_SUBJECT = "[{{ event_label }}] [{{ severity | upper }}] INC-{{ number }}: {{ title }}"
DEFAULT_BODY = """{{ event_label }}: {{ title }}
Severity: {{ severity }}
Status: {{ status }}
{% if resource %}Resource: {{ resource }}
{% endif %}Condition: {{ condition }}
First detected: {{ first_detected }} UTC
{% if resolution %}Resolution: {{ resolution }}
{% endif %}
{{ url }}"""

EVENT_LABELS = {
    "triggered": "TRIGGERED", "reopened": "REOPENED", "escalated": "ESCALATED", "acknowledged": "ACKNOWLEDGED",
    "resolved": "RESOLVED", "test": "TEST",
}


def template_context(inc: Any, event: str, resource_name: str | None) -> dict[str, Any]:
    base = get_settings().public_base_url.rstrip("/")
    return {
        "event": str(event),
        "event_label": EVENT_LABELS.get(str(event), str(event).upper()),
        "number": inc.number,
        "title": inc.title,
        "severity": inc.severity,
        "status": inc.status,
        "resource": resource_name or "",
        "condition": inc.trigger_condition or inc.title,
        "first_detected": inc.first_detected_at.strftime("%Y-%m-%d %H:%M:%S") if inc.first_detected_at else "",
        "resolution": inc.resolution if str(event) == "resolved" else "",
        "url": f"{base}/incidents/{inc.id}",
        "incident_id": str(inc.id),
    }


def render(template: str, ctx: dict[str, Any]) -> str:
    return _env.from_string(template).render(**ctx)


def render_message(templates: dict[str, Any], inc: Any, event: str, resource_name: str | None) -> tuple[str, str]:
    ctx = template_context(inc, event, resource_name)
    subject_t = templates.get("subject") or DEFAULT_SUBJECT
    body_t = templates.get("body") or DEFAULT_BODY
    try:
        return render(subject_t, ctx).strip()[:500], render(body_t, ctx).strip()[:8000]
    except TemplateError:
        # A broken custom template must never block alerting: fall back to defaults.
        return render(DEFAULT_SUBJECT, ctx).strip()[:500], render(DEFAULT_BODY, ctx).strip()[:8000]


def validate_template(template: str) -> str | None:
    class _Fake:
        number = 1
        title = "Example"
        severity = "critical"
        status = "triggered"
        trigger_condition = "cpu_percent > 95"
        first_detected_at = None
        resolution = ""
        id = "00000000-0000-0000-0000-000000000000"

    try:
        render(template, template_context(_Fake(), "triggered", "web-01"))
    except TemplateError as exc:
        return str(exc)
    return None
