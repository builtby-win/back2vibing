import os
import subprocess
import json
import logging

# back2vibing Hermes Hooks
# Configured via back2vibing app

logger = logging.getLogger(__name__)

AGENT_ID = "hermes"

def _notify_b2v(event_name, data=None):
    """Notify back2vibing about an agent event."""
    try:
        script_path = "__B2V_AGENT_EVENT_SCRIPT_PATH__"
        if not os.path.exists(script_path):
            return

        cmd = [
            script_path,
            AGENT_ID,
            "--event", event_name
        ]

        payload = dict(data or {})
        payload["event"] = event_name
        # b2v-agent-event.sh forwards stdin to `b2v agent-event`; environment-only
        # metadata is invisible to the parser and produces raw_bytes=0.
        payload_json = json.dumps(payload)

        subprocess.run(
            cmd,
            input=payload_json,
            text=True,
            env=os.environ.copy(),
            check=False,
            capture_output=True,
        )
    except Exception as e:
        # Avoid crashing the agent if notification fails
        logger.debug(f"[B2V] Error: {e}")

def on_session_start(**kwargs):
    _notify_b2v("on_session_start", {"session_id": kwargs.get("session_id")})

def pre_llm_call(**kwargs):
    _notify_b2v("pre_llm_call", {"session_id": kwargs.get("session_id")})

def pre_tool_call(**kwargs):
    _notify_b2v(
        "pre_tool_call",
        {
            "session_id": kwargs.get("session_id"),
            "tool_name": kwargs.get("tool_name"),
        },
    )

def pre_approval_request(**kwargs):
    _notify_b2v(
        "pre_approval_request",
        {
            "session_id": kwargs.get("session_id"),
            "command": kwargs.get("command"),
            "surface": kwargs.get("surface"),
        },
    )

def on_session_end(**kwargs):
    _notify_b2v(
        "on_session_end",
        {
            "session_id": kwargs.get("session_id"),
            "completed": kwargs.get("completed"),
            "interrupted": kwargs.get("interrupted"),
        },
    )

def register(ctx):
    """Register hooks with Hermes."""
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_approval_request", pre_approval_request)
    ctx.register_hook("on_session_end", on_session_end)
