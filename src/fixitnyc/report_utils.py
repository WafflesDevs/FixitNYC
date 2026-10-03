"""Shared report helpers used by client, staff, and Vortex routes."""

from collections import Counter
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException, UploadFile, status

from fixitnyc.config import Settings, get_settings
from fixitnyc.db import get_service_client
from fixitnyc.schemas import (
    City,
    CountBucket,
    Priority,
    ProblemType,
    ReportDetail,
    ReportStatus,
    StaffSummaryResponse,
)

ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def default_priority(problem_type: ProblemType) -> Priority:
    if problem_type == ProblemType.INFRASTRUCTURE:
        return Priority.HIGH
    return Priority.LOW


async def read_and_validate_image(image: UploadFile, settings: Settings) -> tuple[bytes, str]:
    content_type = (image.content_type or "").lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image must be jpeg, png, or webp",
        )
    data = await image.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image file is empty",
        )
    if len(data) > settings.report_image_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image must be 5 MB or smaller",
        )
    return data, content_type


def upload_report_image(
    *,
    owner_folder: str,
    report_id: UUID,
    data: bytes,
    content_type: str,
) -> str:
    settings = get_settings()
    extension = ALLOWED_IMAGE_TYPES[content_type]
    path = f"{owner_folder}/{report_id}{extension}"
    get_service_client().storage.from_(settings.report_image_bucket).upload(
        path,
        data,
        file_options={"content-type": content_type, "upsert": "true"},
    )
    return path


def signed_image_url(image_path: str | None) -> str | None:
    if not image_path:
        return None
    settings = get_settings()
    result = get_service_client().storage.from_(
        settings.report_image_bucket
    ).create_signed_url(image_path, settings.signed_url_expires_seconds)
    if isinstance(result, dict):
        return result.get("signedURL") or result.get("signedUrl")
    return getattr(result, "signed_url", None) or getattr(result, "signedURL", None)


def attach_reporter_profiles(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add reporter_email / reporter_full_name from profiles (in place).

    Anonymous rows (null reporter_id) fall back to contact_email for reporter_email.
    """
    reporter_ids = sorted(
        {str(row["reporter_id"]) for row in rows if row.get("reporter_id")}
    )
    by_id: dict[str, dict[str, Any]] = {}
    if reporter_ids:
        result = (
            get_service_client()
            .table("profiles")
            .select("id,email,full_name")
            .in_("id", reporter_ids)
            .execute()
        )
        by_id = {str(profile["id"]): profile for profile in (result.data or [])}

    for row in rows:
        reporter_id = row.get("reporter_id")
        profile = by_id.get(str(reporter_id)) if reporter_id else None
        if profile is None:
            row["reporter_email"] = row.get("contact_email")
            row["reporter_full_name"] = None
            continue
        row["reporter_email"] = profile.get("email")
        row["reporter_full_name"] = profile.get("full_name")
    return rows


def to_report_detail(row: dict[str, Any], *, include_signed_url: bool) -> ReportDetail:
    attach_reporter_profiles([row])
    detail = ReportDetail.model_validate(row)
    if include_signed_url:
        detail.image_url = signed_image_url(detail.image_path)
    return detail


def apply_report_filters(
    query: Any,
    *,
    city: City | None = None,
    problem_type: ProblemType | None = None,
    status_filter: ReportStatus | None = None,
    priority: Priority | None = None,
    reported_after: datetime | None = None,
    reported_before: datetime | None = None,
) -> Any:
    if city is not None:
        query = query.eq("city", city.value)
    if problem_type is not None:
        query = query.eq("problem_type", problem_type.value)
    if status_filter is not None:
        query = query.eq("status", status_filter.value)
    if priority is not None:
        query = query.eq("priority", priority.value)
    if reported_after is not None:
        query = query.gte("reported_at", reported_after.isoformat())
    if reported_before is not None:
        query = query.lte("reported_at", reported_before.isoformat())
    return query


def sort_staff_reports(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    high = [row for row in rows if row.get("priority") == Priority.HIGH.value]
    low = [row for row in rows if row.get("priority") != Priority.HIGH.value]
    high.sort(key=lambda row: row.get("reported_at") or "", reverse=True)
    low.sort(key=lambda row: row.get("reported_at") or "", reverse=True)
    return high + low


def build_summary(rows: list[dict[str, Any]]) -> StaffSummaryResponse:
    def buckets(counter: Counter[str]) -> list[CountBucket]:
        return [
            CountBucket(key=key, count=count)
            for key, count in sorted(counter.items(), key=lambda item: item[0])
        ]

    def city_key(row: dict[str, Any]) -> str:
        city = row.get("city")
        return str(city) if city else "unspecified"

    return StaffSummaryResponse(
        by_city=buckets(Counter(city_key(row) for row in rows)),
        by_problem_type=buckets(Counter(row["problem_type"] for row in rows)),
        by_status=buckets(Counter(row["status"] for row in rows)),
        by_day=buckets(
            Counter(
                (row["reported_at"] or "")[:10]
                for row in rows
                if row.get("reported_at")
            )
        ),
        total=len(rows),
    )
