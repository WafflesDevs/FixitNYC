"""Vortex staff chat: read-only report tools + conversation persistence."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from supabase import Client

from fixitnyc.config import get_settings
from fixitnyc.deps import CurrentUser, require_staff
from fixitnyc.report_utils import (
    apply_report_filters,
    attach_reporter_profiles,
    build_summary,
    sort_staff_reports,
)
from fixitnyc.schemas import (
    City,
    Priority,
    ProblemType,
    ReportStatus,
    VortexChatRequest,
    VortexChatResponse,
    VortexConversationSummary,
    VortexConversationsResponse,
    VortexNewConversationResponse,
    VortexTranscriptMessage,
    VortexTranscriptResponse,
)

SYSTEM_PROMPT = """You are Vortex, a staff-only assistant for FixItNYC.

You answer questions about FixItNYC issue reports using live database tools.
For any factual question about reports, queues, counts, statuses, priorities, cities,
problem types, addresses, or reporters: call a tool first. Never invent report data.
If tools return nothing, say so clearly.

Available tools (all read-only against the reports database):
- summarize_reports: totals and breakdowns (city / status / priority / problem type / day)
- list_reports: filtered queue (high priority first)
- search_reports: text search over name, address, and additional info
- count_reports: filtered count
- get_report: one report by id, including reporter details

Statuses are: submitted, reviewed, in_progress, canceled, done.
Priorities are: high, low.
Refuse requests outside FixItNYC reports/ops. Never write SQL or change data.
Format replies as a short staff note: brief sentences, blank lines between sections,
and bullet lists with "- " for queues or breakdowns. Use **bold** sparingly for key counts.
Keep answers concise and operational for city staff.
"""

router = APIRouter(prefix="/vortex", tags=["vortex"])


class ReportFilterArgs(BaseModel):
    city: City | None = None
    problem_type: ProblemType | None = None
    status: ReportStatus | None = None
    priority: Priority | None = None


class ListReportsArgs(ReportFilterArgs):
    limit: int = Field(default=10, ge=1, le=25)


class SearchReportsArgs(ReportFilterArgs):
    query: str = Field(min_length=1, max_length=120)
    limit: int = Field(default=10, ge=1, le=25)


class GetReportArgs(BaseModel):
    report_id: str = Field(min_length=1, max_length=64)


def _sanitize_search(query: str) -> str:
    cleaned = re.sub(r"[,%()]", " ", query).strip()
    return cleaned[:120]


def _matches_search(row: dict[str, Any], needle: str) -> bool:
    haystacks = (
        row.get("name"),
        row.get("address_area"),
        row.get("additional_info"),
    )
    return any(needle in str(value).lower() for value in haystacks if value)


def _query_reports(
    user_client: Client,
    *,
    city: City | None = None,
    problem_type: ProblemType | None = None,
    status: ReportStatus | None = None,
    priority: Priority | None = None,
    search: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    query = apply_report_filters(
        user_client.table("reports").select("*"),
        city=city,
        problem_type=problem_type,
        status_filter=status,
        priority=priority,
    )
    rows = sort_staff_reports(query.execute().data or [])
    if search:
        needle = _sanitize_search(search).lower()
        if needle:
            rows = [row for row in rows if _matches_search(row, needle)]
    if limit is not None:
        rows = rows[:limit]
    attach_reporter_profiles(rows)
    return rows


def _public_report_row(row: dict[str, Any], *, detail: bool = False) -> dict[str, Any]:
    payload = {
        "id": row["id"],
        "city": row["city"],
        "problem_type": row["problem_type"],
        "status": row["status"],
        "priority": row["priority"],
        "name": row["name"],
        "address_area": row["address_area"],
        "reported_at": row["reported_at"],
        "reporter_full_name": row.get("reporter_full_name"),
        "reporter_email": row.get("reporter_email"),
    }
    if detail:
        payload.update(
            {
                "reporter_id": row.get("reporter_id"),
                "additional_info": row.get("additional_info"),
                "image_path": row.get("image_path"),
            }
        )
    return payload


def _build_tools(user_client: Client, row_cap: int) -> list[StructuredTool]:
    def list_reports(
        city: City | None = None,
        problem_type: ProblemType | None = None,
        status: ReportStatus | None = None,
        priority: Priority | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """List FixItNYC reports from the database with optional filters."""
        rows = _query_reports(
            user_client,
            city=city,
            problem_type=problem_type,
            status=status,
            priority=priority,
            limit=min(limit, row_cap),
        )
        return [_public_report_row(row) for row in rows]

    def search_reports(
        query: str,
        city: City | None = None,
        problem_type: ProblemType | None = None,
        status: ReportStatus | None = None,
        priority: Priority | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Search reports in the database by name, address, or additional info."""
        rows = _query_reports(
            user_client,
            city=city,
            problem_type=problem_type,
            status=status,
            priority=priority,
            search=query,
            limit=min(limit, row_cap),
        )
        return [_public_report_row(row, detail=True) for row in rows]

    def count_reports(
        city: City | None = None,
        problem_type: ProblemType | None = None,
        status: ReportStatus | None = None,
        priority: Priority | None = None,
    ) -> dict[str, int]:
        """Count FixItNYC reports in the database with optional filters."""
        rows = _query_reports(
            user_client,
            city=city,
            problem_type=problem_type,
            status=status,
            priority=priority,
        )
        return {"count": len(rows)}

    def summarize_reports(
        city: City | None = None,
        problem_type: ProblemType | None = None,
        status: ReportStatus | None = None,
        priority: Priority | None = None,
    ) -> dict[str, Any]:
        """Summarize FixItNYC reports from the database (totals and breakdowns)."""
        rows = _query_reports(
            user_client,
            city=city,
            problem_type=problem_type,
            status=status,
            priority=priority,
        )
        summary = build_summary(rows)
        return summary.model_dump()

    def get_report(report_id: str) -> dict[str, Any]:
        """Fetch one FixItNYC report from the database by id."""
        result = (
            user_client.table("reports")
            .select("*")
            .eq("id", report_id.strip())
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return {"error": "Report not found"}
        attach_reporter_profiles(rows)
        return _public_report_row(rows[0], detail=True)

    return [
        StructuredTool.from_function(
            func=summarize_reports,
            name="summarize_reports",
            description=(
                "Fetch live totals and breakdowns of FixItNYC reports from the database "
                "(by city, status, priority, problem type, day). Read-only."
            ),
            args_schema=ReportFilterArgs,
        ),
        StructuredTool.from_function(
            func=list_reports,
            name="list_reports",
            description=(
                "List FixItNYC reports from the database with optional filters. "
                "Sorted high priority first. Read-only."
            ),
            args_schema=ListReportsArgs,
        ),
        StructuredTool.from_function(
            func=search_reports,
            name="search_reports",
            description=(
                "Search FixItNYC reports in the database by text in name, address, "
                "or additional info. Optional filters supported. Read-only."
            ),
            args_schema=SearchReportsArgs,
        ),
        StructuredTool.from_function(
            func=count_reports,
            name="count_reports",
            description="Count FixItNYC reports in the database with optional filters. Read-only.",
            args_schema=ReportFilterArgs,
        ),
        StructuredTool.from_function(
            func=get_report,
            name="get_report",
            description=(
                "Get one FixItNYC report from the database by id, including reporter "
                "name/email and additional info. Read-only."
            ),
            args_schema=GetReportArgs,
        ),
    ]


def _message_text(message: Any) -> str:
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
        return "".join(parts)
    return str(content)


def _create_conversation(user_client: Client, staff_id: UUID) -> UUID:
    created = (
        user_client.table("vortex_conversations")
        .insert({"staff_id": str(staff_id)})
        .execute()
    )
    created_rows = created.data or []
    if not created_rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create Vortex conversation",
        )
    return UUID(created_rows[0]["id"])


def _latest_conversation_id(user_client: Client, staff_id: UUID) -> UUID | None:
    existing = (
        user_client.table("vortex_conversations")
        .select("id")
        .eq("staff_id", str(staff_id))
        .order("updated_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = existing.data or []
    return UUID(rows[0]["id"]) if rows else None


def _get_owned_conversation(
    user_client: Client,
    staff_id: UUID,
    conversation_id: UUID,
) -> UUID:
    result = (
        user_client.table("vortex_conversations")
        .select("id")
        .eq("id", str(conversation_id))
        .eq("staff_id", str(staff_id))
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found",
        )
    return UUID(rows[0]["id"])


def _ensure_conversation(user_client: Client, staff_id: UUID) -> UUID:
    existing_id = _latest_conversation_id(user_client, staff_id)
    if existing_id is not None:
        return existing_id
    return _create_conversation(user_client, staff_id)


def _resolve_conversation(
    user_client: Client,
    staff_id: UUID,
    conversation_id: UUID | None,
) -> UUID:
    if conversation_id is not None:
        return _get_owned_conversation(user_client, staff_id, conversation_id)
    return _ensure_conversation(user_client, staff_id)


def _fetch_transcript_rows(
    user_client: Client,
    conversation_id: UUID,
    *,
    limit: int,
    newest_first: bool = False,
) -> list[dict[str, Any]]:
    result = (
        user_client.table("vortex_messages")
        .select("role, content, created_at")
        .eq("conversation_id", str(conversation_id))
        .order("created_at", desc=newest_first)
        .limit(limit)
        .execute()
    )
    rows = result.data or []
    if newest_first:
        rows = list(reversed(rows))
    return rows


def _load_history(user_client: Client, conversation_id: UUID) -> list[HumanMessage | AIMessage]:
    # Keep model context short; full transcript is available via GET /vortex/transcript.
    history: list[HumanMessage | AIMessage] = []
    for row in _fetch_transcript_rows(
        user_client,
        conversation_id,
        limit=20,
        newest_first=True,
    ):
        if row["role"] == "user":
            history.append(HumanMessage(content=row["content"]))
        else:
            history.append(AIMessage(content=row["content"]))
    return history


def _touch_conversation(user_client: Client, conversation_id: UUID) -> None:
    # Bump updated_at so "latest chat" / conversation list sort by recent activity.
    user_client.table("vortex_conversations").update(
        {"updated_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", str(conversation_id)).execute()


def _persist_turn(
    user_client: Client,
    conversation_id: UUID,
    user_message: str,
    assistant_message: str,
) -> None:
    user_client.table("vortex_messages").insert(
        [
            {
                "conversation_id": str(conversation_id),
                "role": "user",
                "content": user_message,
            },
            {
                "conversation_id": str(conversation_id),
                "role": "assistant",
                "content": assistant_message,
            },
        ]
    ).execute()
    _touch_conversation(user_client, conversation_id)


def run_vortex_turn(
    *,
    user_client: Client,
    staff_id: UUID,
    message: str,
    conversation_id: UUID | None = None,
) -> tuple[UUID, str]:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ANTHROPIC_API_KEY is not configured",
        )
    if len(message) > settings.vortex_max_message_chars:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Message exceeds {settings.vortex_max_message_chars} characters",
        )

    conversation_id = _resolve_conversation(user_client, staff_id, conversation_id)
    history = _load_history(user_client, conversation_id)
    tools = _build_tools(user_client, settings.vortex_report_row_cap)
    tools_by_name = {tool.name: tool for tool in tools}
    llm = ChatAnthropic(
        model=settings.vortex_model,
        api_key=settings.anthropic_api_key,
        temperature=0,
        max_tokens=1024,
    ).bind_tools(tools)

    messages: list[Any] = [
        SystemMessage(content=SYSTEM_PROMPT),
        *history,
        HumanMessage(content=message),
    ]
    reply_text = ""

    for _ in range(4):
        ai_message = llm.invoke(messages)
        messages.append(ai_message)
        if not isinstance(ai_message, AIMessage):
            reply_text = str(ai_message.content)
            break

        tool_calls = getattr(ai_message, "tool_calls", None) or []
        if not tool_calls:
            reply_text = _message_text(ai_message)
            break

        for call in tool_calls:
            name = call["name"]
            args = call.get("args") or {}
            tool = tools_by_name.get(name)
            try:
                tool_result: Any = (
                    {"error": f"Unknown tool: {name}"}
                    if tool is None
                    else tool.invoke(args)
                )
            except Exception as exc:  # noqa: BLE001
                tool_result = {"error": f"Tool {name} failed: {exc}"}
            content = (
                json.dumps(tool_result, default=str)
                if not isinstance(tool_result, str)
                else tool_result
            )
            messages.append(
                ToolMessage(content=content, tool_call_id=call["id"])
            )
    else:
        reply_text = (
            _message_text(messages[-1]) if messages else "I could not complete that request."
        )

    if not reply_text.strip():
        reply_text = "I could not find an answer for that request."

    _persist_turn(user_client, conversation_id, message, reply_text)
    return conversation_id, reply_text


@router.get("/conversations", response_model=VortexConversationsResponse)
def list_vortex_conversations(
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> VortexConversationsResponse:
    """List the staff member's recent Vortex conversations (most recent first)."""
    result = (
        current_user.user_client.table("vortex_conversations")
        .select("id, created_at, updated_at")
        .eq("staff_id", str(current_user.id))
        .order("updated_at", desc=True)
        .limit(20)
        .execute()
    )
    rows = result.data or []
    if not rows:
        return VortexConversationsResponse(conversations=[])

    conversation_ids = [str(row["id"]) for row in rows]
    messages = (
        current_user.user_client.table("vortex_messages")
        .select("conversation_id, role, content, created_at")
        .in_("conversation_id", conversation_ids)
        .eq("role", "user")
        .order("created_at", desc=False)
        .execute()
    )
    preview_by_id: dict[str, str] = {}
    for message in messages.data or []:
        cid = str(message["conversation_id"])
        if cid not in preview_by_id:
            preview = str(message.get("content") or "").strip().replace("\n", " ")
            preview_by_id[cid] = preview[:80] + ("…" if len(preview) > 80 else "")

    return VortexConversationsResponse(
        conversations=[
            VortexConversationSummary(
                id=row["id"],
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
                preview=preview_by_id.get(str(row["id"])) or "New chat",
            )
            for row in rows
        ]
    )


@router.post("/conversations", response_model=VortexNewConversationResponse)
def create_vortex_conversation(
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> VortexNewConversationResponse:
    """Start a new empty Vortex conversation (Gemini-style New chat)."""
    conversation_id = _create_conversation(current_user.user_client, current_user.id)
    return VortexNewConversationResponse(conversation_id=conversation_id)


@router.get("/transcript", response_model=VortexTranscriptResponse)
def vortex_transcript(
    current_user: Annotated[CurrentUser, Depends(require_staff)],
    conversation_id: Annotated[UUID | None, Query()] = None,
) -> VortexTranscriptResponse:
    """Return a saved Vortex chat transcript (latest, or a specific conversation)."""
    if conversation_id is not None:
        resolved_id = _get_owned_conversation(
            current_user.user_client,
            current_user.id,
            conversation_id,
        )
    else:
        resolved_id = _latest_conversation_id(
            current_user.user_client,
            current_user.id,
        )
        if resolved_id is None:
            return VortexTranscriptResponse(conversation_id=None, messages=[])

    rows = _fetch_transcript_rows(
        current_user.user_client,
        resolved_id,
        limit=200,
    )
    return VortexTranscriptResponse(
        conversation_id=resolved_id,
        messages=[
            VortexTranscriptMessage(
                role=row["role"],
                content=row["content"],
                created_at=row.get("created_at"),
            )
            for row in rows
        ],
    )


@router.post("/chat", response_model=VortexChatResponse)
def vortex_chat(
    body: VortexChatRequest,
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> VortexChatResponse:
    try:
        conversation_id, reply = run_vortex_turn(
            user_client=current_user.user_client,
            staff_id=current_user.id,
            message=body.message.strip(),
            conversation_id=body.conversation_id,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Vortex failed: {exc}",
        ) from exc

    return VortexChatResponse(conversation_id=conversation_id, reply=reply)
