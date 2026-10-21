"""Command line: emonitor-agent {enroll,run,status,collect-once,version}."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

from monitor_agent import __version__
from monitor_agent.agent import DEFAULT_CONFIG, Agent, Config, enroll, read_credentials


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="emonitor-agent")
    p.add_argument("--config", default=os.environ.get("EMONITOR_AGENT_CONFIG", DEFAULT_CONFIG))
    p.add_argument("--log-level", default="INFO")
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("enroll", help="enroll this host using a one-time token")
    e.add_argument("--server", help="server URL (overrides config)")
    e.add_argument("--token", default=os.environ.get("EMONITOR_ENROLLMENT_TOKEN"))
    sub.add_parser("run", help="run the collection loop (systemd)")
    sub.add_parser("status", help="show enrollment and spool status")
    sub.add_parser("collect-once", help="print one metric sample (no network)")
    sub.add_parser("version")
    args = p.parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr)

    if args.cmd == "version":
        print(__version__)
        return 0
    if args.cmd == "collect-once":
        from monitor_agent.collectors import get_collector

        cfg = Config.load(args.config) if os.path.exists(args.config) else Config(server_url="https://unset")
        c = get_collector(cfg.services)
        c.collect()
        import time

        time.sleep(1)
        print(json.dumps({"system": c.system_info(), "metrics": c.collect()}, indent=2))
        return 0
    cfg = Config.load(args.config)
    if args.cmd == "enroll":
        if args.server:
            cfg.server_url = args.server
        if not args.token:
            print("enrollment token required (--token or EMONITOR_ENROLLMENT_TOKEN)", file=sys.stderr)
            return 2
        creds = enroll(cfg, args.token)
        if args.server:  # persist the server URL used for enrollment
            with open(args.config, encoding="utf-8") as fh:
                raw = json.load(fh)
            raw["server_url"] = args.server
            with open(args.config, "w", encoding="utf-8") as fh:
                json.dump(raw, fh, indent=2)
        print(f"enrolled: agent {creds['agent_id']} for server {creds['server_id']}")
        return 0
    if args.cmd == "status":
        creds = read_credentials(cfg.credentials_file)
        from pathlib import Path

        spool = Path(cfg.state_dir) / "spool"
        print(json.dumps({"version": __version__, "server_url": cfg.server_url, "enrolled": bool(creds),
                          "agent_id": creds.get("agent_id") if creds else None,
                          "rotated_at": creds.get("rotated_at") if creds else None,
                          "spool_batches": len(list(spool.glob("*.json"))) if spool.exists() else 0}, indent=2))
        return 0
    Agent(cfg).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
