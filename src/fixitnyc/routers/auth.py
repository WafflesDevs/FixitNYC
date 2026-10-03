from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from fixitnyc.config import get_settings
from fixitnyc.db import get_service_client
from fixitnyc.deps import CurrentUser, fetch_profile, get_current_user
from fixitnyc.schemas import (
    AuthSessionResponse,
    LoginRequest,
    PasswordChangeRequest,
    ProfileResponse,
    RefreshRequest,
    RegisterRequest,
    SettingsUpdateRequest,
    TokenResponse,
    UserRole,
)
from fixitnyc.security import decode_token, hash_password, issue_tokens, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])
settings_router = APIRouter(prefix="/settings", tags=["settings"])


def _find_profile_by_email(email: str) -> dict[str, Any] | None:
    result = (
        get_service_client()
        .table("profiles")
        .select("*")
        .eq("email", email.lower())
        .limit(1)
        .execute()
    )
    rows = result.data or []
    return rows[0] if rows else None


@router.post("/register", response_model=AuthSessionResponse, status_code=201)
def register(body: RegisterRequest) -> AuthSessionResponse:
    email = body.email.strip().lower()
    if _find_profile_by_email(email) is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    role = (
        UserRole.STAFF
        if email in get_settings().bootstrap_staff_emails
        else UserRole.CLIENT
    )
    user_id = str(uuid4())
    row = {
        "id": user_id,
        "email": email,
        "full_name": body.full_name,
        "role": role.value,
        "password_hash": hash_password(body.password),
    }
    result = get_service_client().table("profiles").insert(row).execute()
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Registration failed",
        )

    return AuthSessionResponse(
        user=fetch_profile(user_id),
        session=issue_tokens(user_id),
    )


@router.post("/login", response_model=AuthSessionResponse)
def login(body: LoginRequest) -> AuthSessionResponse:
    row = _find_profile_by_email(body.email.strip().lower())
    if row is None or not verify_password(body.password, row.get("password_hash") or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    user_id = str(row["id"])
    return AuthSessionResponse(
        user=ProfileResponse.model_validate(
            {k: row[k] for k in ("id", "email", "full_name", "role", "created_at", "updated_at") if k in row}
        ),
        session=issue_tokens(user_id),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest) -> TokenResponse:
    try:
        user_id = decode_token(body.refresh_token, expected_type="refresh")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        ) from exc
    # Ensure the profile still exists.
    fetch_profile(user_id)
    return issue_tokens(user_id)


@router.post("/logout", status_code=204)
def logout(
    _current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    # Stateless JWT sessions: client discards tokens.
    return None


@router.get("/me", response_model=ProfileResponse)
def me(
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> ProfileResponse:
    return current_user.profile


@settings_router.patch("", response_model=ProfileResponse)
def update_settings(
    body: SettingsUpdateRequest,
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> ProfileResponse:
    if body.full_name is None and body.email is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide full_name and/or email",
        )

    profile_updates: dict[str, Any] = {}

    if body.email is not None and body.email.lower() != current_user.profile.email.lower():
        email = body.email.lower()
        existing = _find_profile_by_email(email)
        if existing is not None and str(existing["id"]) != str(current_user.id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered",
            )
        profile_updates["email"] = email

    if body.full_name is not None:
        profile_updates["full_name"] = body.full_name

    if profile_updates:
        get_service_client().table("profiles").update(profile_updates).eq(
            "id", str(current_user.id)
        ).execute()

    return fetch_profile(str(current_user.id))


@settings_router.post("/password", status_code=204)
def change_password(
    body: PasswordChangeRequest,
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> None:
    get_service_client().table("profiles").update(
        {"password_hash": hash_password(body.password)}
    ).eq("id", str(current_user.id)).execute()
