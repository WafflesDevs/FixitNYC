from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class UserRole(StrEnum):
    CLIENT = "client"
    STAFF = "staff"


class City(StrEnum):
    MANHATTAN = "Manhattan"
    BROOKLYN = "Brooklyn"
    QUEENS = "Queens"
    BRONX = "Bronx"
    STATEN_ISLAND = "Staten Island"


class ProblemType(StrEnum):
    SANITATION = "sanitation"
    INFRASTRUCTURE = "infrastructure"


class ReportStatus(StrEnum):
    SUBMITTED = "submitted"
    REVIEWED = "reviewed"
    IN_PROGRESS = "in_progress"
    CANCELED = "canceled"
    DONE = "done"


class Priority(StrEnum):
    HIGH = "high"
    LOW = "low"


class ProfileResponse(BaseModel):
    id: UUID
    email: EmailStr | str
    full_name: str
    role: UserRole
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=1, max_length=200)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int | None = None


class AuthSessionResponse(BaseModel):
    user: ProfileResponse
    session: TokenResponse


class SettingsUpdateRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    email: EmailStr | None = None


class PasswordChangeRequest(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class ReportListItem(BaseModel):
    id: UUID
    reporter_id: UUID | None = None
    address_area: str | None = None
    city: City | None = None
    name: str
    problem_type: ProblemType
    image_path: str | None = None
    reported_at: datetime
    additional_info: str | None = None
    contact_email: str | None = None
    status: ReportStatus
    priority: Priority
    reporter_email: str | None = None
    reporter_full_name: str | None = None


class ReportDetail(ReportListItem):
    image_url: str | None = None


class ReportPatch(BaseModel):
    status: ReportStatus | None = None
    priority: Priority | None = None


class StaffAccountsPatch(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: UserRole | None = None


class CountBucket(BaseModel):
    key: str
    count: int


class StaffSummaryResponse(BaseModel):
    by_city: list[CountBucket]
    by_problem_type: list[CountBucket]
    by_status: list[CountBucket]
    by_day: list[CountBucket]
    total: int


class VortexChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    conversation_id: UUID | None = None


class VortexChatResponse(BaseModel):
    conversation_id: UUID
    reply: str


class VortexTranscriptMessage(BaseModel):
    role: str
    content: str
    created_at: datetime | None = None


class VortexTranscriptResponse(BaseModel):
    conversation_id: UUID | None = None
    messages: list[VortexTranscriptMessage]


class VortexConversationSummary(BaseModel):
    id: UUID
    created_at: datetime | None = None
    updated_at: datetime | None = None
    preview: str | None = None


class VortexConversationsResponse(BaseModel):
    conversations: list[VortexConversationSummary]


class VortexNewConversationResponse(BaseModel):
    conversation_id: UUID
