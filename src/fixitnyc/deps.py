from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from supabase import Client

from fixitnyc.db import get_service_client
from fixitnyc.schemas import ProfileResponse, UserRole
from fixitnyc.security import decode_token

bearer_scheme = HTTPBearer(auto_error=False)

PROFILE_COLUMNS = "id,email,full_name,role,created_at,updated_at"


class CurrentUser:
    def __init__(
        self,
        *,
        profile: ProfileResponse,
        access_token: str,
        user_client: Client,
    ) -> None:
        self.profile = profile
        self.access_token = access_token
        self.user_client = user_client

    @property
    def id(self) -> UUID:
        return self.profile.id

    @property
    def role(self) -> UserRole:
        return self.profile.role

    @property
    def is_staff(self) -> bool:
        return self.profile.role == UserRole.STAFF


def fetch_profile(user_id: str) -> ProfileResponse:
    result = (
        get_service_client()
        .table("profiles")
        .select(PROFILE_COLUMNS)
        .eq("id", user_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found",
        )
    return ProfileResponse.model_validate(rows[0])


async def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(bearer_scheme),
    ],
) -> CurrentUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )

    access_token = credentials.credentials
    try:
        user_id = decode_token(access_token, expected_type="access")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
        ) from exc

    return CurrentUser(
        profile=fetch_profile(user_id),
        access_token=access_token,
        # Service client: auth is app-managed via profiles, not Supabase Auth JWTs.
        user_client=get_service_client(),
    )


async def require_staff(
    current_user: Annotated[CurrentUser, Depends(get_current_user)],
) -> CurrentUser:
    if not current_user.is_staff:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Staff access required",
        )
    return current_user
