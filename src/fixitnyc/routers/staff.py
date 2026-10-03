from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from fixitnyc.deps import PROFILE_COLUMNS, CurrentUser, fetch_profile, require_staff
from fixitnyc.report_utils import (
    apply_report_filters,
    attach_reporter_profiles,
    build_summary,
    sort_staff_reports,
    to_report_detail,
)
from fixitnyc.schemas import (
    City,
    Priority,
    ProblemType,
    ProfileResponse,
    ReportDetail,
    ReportListItem,
    ReportPatch,
    ReportStatus,
    StaffAccountsPatch,
    StaffSummaryResponse,
)

router = APIRouter(prefix="/staff", tags=["staff"])


def _filtered_reports(
    current_user: CurrentUser,
    *,
    city: City | None,
    problem_type: ProblemType | None,
    status_filter: ReportStatus | None,
    priority: Priority | None,
    reported_after: datetime | None,
    reported_before: datetime | None,
) -> list[dict[str, Any]]:
    query = apply_report_filters(
        current_user.user_client.table("reports").select("*"),
        city=city,
        problem_type=problem_type,
        status_filter=status_filter,
        priority=priority,
        reported_after=reported_after,
        reported_before=reported_before,
    )
    return sort_staff_reports(query.execute().data or [])


@router.get("/reports", response_model=list[ReportListItem])
def list_staff_reports(
    current_user: Annotated[CurrentUser, Depends(require_staff)],
    city: City | None = None,
    problem_type: ProblemType | None = None,
    status_filter: Annotated[
        ReportStatus | None,
        Query(alias="status"),
    ] = None,
    priority: Priority | None = None,
    reported_after: datetime | None = None,
    reported_before: datetime | None = None,
) -> list[ReportListItem]:
    rows = _filtered_reports(
        current_user,
        city=city,
        problem_type=problem_type,
        status_filter=status_filter,
        priority=priority,
        reported_after=reported_after,
        reported_before=reported_before,
    )
    attach_reporter_profiles(rows)
    return [ReportListItem.model_validate(row) for row in rows]


@router.get("/reports/summary", response_model=StaffSummaryResponse)
def staff_reports_summary(
    current_user: Annotated[CurrentUser, Depends(require_staff)],
    city: City | None = None,
    problem_type: ProblemType | None = None,
    status_filter: Annotated[
        ReportStatus | None,
        Query(alias="status"),
    ] = None,
    priority: Priority | None = None,
    reported_after: datetime | None = None,
    reported_before: datetime | None = None,
) -> StaffSummaryResponse:
    rows = _filtered_reports(
        current_user,
        city=city,
        problem_type=problem_type,
        status_filter=status_filter,
        priority=priority,
        reported_after=reported_after,
        reported_before=reported_before,
    )
    return build_summary(rows)


@router.get("/reports/{report_id}", response_model=ReportDetail)
def get_staff_report(
    report_id: UUID,
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> ReportDetail:
    result = (
        current_user.user_client.table("reports")
        .select("*")
        .eq("id", str(report_id))
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )
    return to_report_detail(rows[0], include_signed_url=True)


@router.patch("/reports/{report_id}", response_model=ReportDetail)
def patch_staff_report(
    report_id: UUID,
    body: ReportPatch,
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> ReportDetail:
    updates: dict[str, Any] = {}
    if body.status is not None:
        updates["status"] = body.status.value
    if body.priority is not None:
        updates["priority"] = body.priority.value
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide status and/or priority",
        )

    result = (
        current_user.user_client.table("reports")
        .update(updates)
        .eq("id", str(report_id))
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )
    return to_report_detail(rows[0], include_signed_url=True)


@router.get("/accounts", response_model=list[ProfileResponse])
def list_accounts(
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> list[ProfileResponse]:
    result = (
        current_user.user_client.table("profiles")
        .select(PROFILE_COLUMNS)
        .order("created_at", desc=True)
        .execute()
    )
    return [ProfileResponse.model_validate(row) for row in (result.data or [])]


@router.get("/accounts/{account_id}", response_model=ProfileResponse)
def get_account(
    account_id: UUID,
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> ProfileResponse:
    result = (
        current_user.user_client.table("profiles")
        .select(PROFILE_COLUMNS)
        .eq("id", str(account_id))
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found",
        )
    return ProfileResponse.model_validate(rows[0])


@router.patch("/accounts/{account_id}", response_model=ProfileResponse)
def patch_account(
    account_id: UUID,
    body: StaffAccountsPatch,
    current_user: Annotated[CurrentUser, Depends(require_staff)],
) -> ProfileResponse:
    updates: dict[str, Any] = {}
    if body.full_name is not None:
        updates["full_name"] = body.full_name
    if body.role is not None:
        updates["role"] = body.role.value
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide full_name and/or role",
        )

    result = (
        current_user.user_client.table("profiles")
        .update(updates)
        .eq("id", str(account_id))
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Account not found",
        )

    return fetch_profile(str(account_id))
