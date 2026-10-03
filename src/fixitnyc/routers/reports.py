from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from fixitnyc.config import get_settings
from fixitnyc.db import get_service_client
from fixitnyc.deps import CurrentUser, get_current_user
from fixitnyc.report_utils import (
    default_priority,
    read_and_validate_image,
    to_report_detail,
    upload_report_image,
)
from fixitnyc.schemas import City, ProblemType, ReportDetail, ReportListItem

router = APIRouter(prefix="/reports", tags=["reports"])


@router.post("", response_model=ReportDetail, status_code=201)
async def create_report(
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
    address_area: Annotated[str, Form(min_length=1, max_length=500)],
    city: Annotated[City, Form()],
    name: Annotated[str, Form(min_length=1, max_length=200)],
    problem_type: Annotated[ProblemType, Form()],
    additional_info: Annotated[str | None, Form()] = None,
    image: Annotated[UploadFile | None, File()] = None,
) -> ReportDetail:
    settings = get_settings()
    report_id = uuid4()
    image_path: str | None = None
    if image is not None and image.filename:
        image_bytes, content_type = await read_and_validate_image(image, settings)
        image_path = upload_report_image(
            owner_folder=str(current_user.id),
            report_id=report_id,
            data=image_bytes,
            content_type=content_type,
        )
    payload = {
        "id": str(report_id),
        "reporter_id": str(current_user.id),
        "address_area": address_area,
        "city": city.value,
        "name": name,
        "problem_type": problem_type.value,
        "image_path": image_path,
        "additional_info": additional_info,
        "priority": default_priority(problem_type).value,
        "status": "submitted",
    }
    result = current_user.user_client.table("reports").insert(payload).execute()
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create report",
        )
    return to_report_detail(rows[0], include_signed_url=True)


@router.post("/anonymous", response_model=ReportDetail, status_code=201)
async def create_anonymous_report(
    name: Annotated[str, Form(min_length=1, max_length=200)],
    problem_type: Annotated[ProblemType, Form()],
    additional_info: Annotated[str, Form(min_length=1, max_length=5000)],
    contact_email: Annotated[str | None, Form(max_length=320)] = None,
    image: Annotated[UploadFile | None, File()] = None,
) -> ReportDetail:
    """Public submission with no auth; uses service client (reporter_id null)."""
    settings = get_settings()
    report_id = uuid4()
    image_path: str | None = None
    if image is not None and image.filename:
        image_bytes, content_type = await read_and_validate_image(image, settings)
        image_path = upload_report_image(
            owner_folder="anonymous",
            report_id=report_id,
            data=image_bytes,
            content_type=content_type,
        )

    email = (contact_email or "").strip() or None
    payload = {
        "id": str(report_id),
        "reporter_id": None,
        "address_area": None,
        "city": None,
        "name": name,
        "problem_type": problem_type.value,
        "image_path": image_path,
        "additional_info": additional_info,
        "contact_email": email,
        "priority": default_priority(problem_type).value,
        "status": "submitted",
    }
    result = get_service_client().table("reports").insert(payload).execute()
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create report",
        )
    return to_report_detail(rows[0], include_signed_url=True)


@router.get("", response_model=list[ReportListItem])
def list_my_reports(
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> list[ReportListItem]:
    result = (
        current_user.user_client.table("reports")
        .select("*")
        .eq("reporter_id", str(current_user.id))
        .order("reported_at", desc=True)
        .execute()
    )
    return [ReportListItem.model_validate(row) for row in (result.data or [])]


@router.get("/{report_id}", response_model=ReportDetail)
def get_my_report(
    report_id: UUID,
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
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
    # Signed URL so the prototype UI can show the uploaded image.
    return to_report_detail(rows[0], include_signed_url=True)
