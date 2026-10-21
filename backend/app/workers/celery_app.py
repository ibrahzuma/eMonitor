"""Celery application: queues, reliability settings and periodic (beat) schedule."""

from __future__ import annotations

from celery import Celery
from celery.signals import worker_process_init, worker_process_shutdown
from kombu import Queue

from app.core.config import get_settings

settings = get_settings()

celery_app = Celery("emonitor", broker=settings.broker_url, backend=None, include=["app.workers.tasks"])
celery_app.conf.update(
    task_queues=(Queue("checks"), Queue("notifications"), Queue("maintenance"), Queue("rules")),
    task_default_queue="maintenance",
    task_routes={
        "emonitor.run_check": {"queue": "checks"},
        "emonitor.send_delivery": {"queue": "notifications"},
        "emonitor.dispatch_due_deliveries": {"queue": "notifications"},
        "emonitor.evaluate_rules": {"queue": "rules"},
        "emonitor.evaluate_slos": {"queue": "rules"},
    },
    # Reliability: acknowledge after execution, requeue if a worker dies mid-task.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=4,
    task_ignore_result=True,
    task_time_limit=180,
    task_soft_time_limit=150,
    broker_transport_options={"visibility_timeout": 600},
    broker_connection_retry_on_startup=True,
    worker_max_tasks_per_child=5000,
    timezone="UTC",
    enable_utc=True,
    task_serializer="json",
    accept_content=["json"],
    beat_schedule={
        "agent-liveness": {"task": "emonitor.evaluate_agent_liveness", "schedule": 30.0},
        "escalations": {"task": "emonitor.process_escalations", "schedule": 30.0},
        "due-deliveries": {"task": "emonitor.dispatch_due_deliveries", "schedule": 20.0},
        "alert-rules": {"task": "emonitor.evaluate_rules", "schedule": 15.0},
        "slos": {"task": "emonitor.evaluate_slos", "schedule": 300.0},
        "maintenance-status": {"task": "emonitor.refresh_maintenance_status", "schedule": 60.0},
        "housekeeping": {"task": "emonitor.housekeeping", "schedule": 3600.0},
        "heartbeat": {"task": "emonitor.worker_heartbeat", "schedule": 30.0},
    },
)


@worker_process_init.connect
def _init_worker(**_: object) -> None:
    from app.core.logging import configure_logging

    configure_logging(settings.log_level, settings.log_json)


@worker_process_shutdown.connect
def _shutdown_worker(**_: object) -> None:
    from app.workers.runtime import shutdown_loop

    shutdown_loop()
