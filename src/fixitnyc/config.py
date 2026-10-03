from functools import lru_cache

from pydantic import Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    supabase_url: str = Field(alias="SUPABASE_URL", min_length=1)
    supabase_publishable_key: str = Field(
        alias="SUPABASE_PUBLISHABLE_KEY",
        min_length=1,
    )
    supabase_secret_key: str = Field(alias="SUPABASE_SECRET_KEY", min_length=1)
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    bootstrap_staff_emails_raw: str = Field(
        default="",
        alias="BOOTSTRAP_STAFF_EMAILS",
    )

    report_image_bucket: str = "report-images"
    report_image_max_bytes: int = 5 * 1024 * 1024
    signed_url_expires_seconds: int = 60 * 15
    vortex_max_message_chars: int = 2000
    vortex_report_row_cap: int = 25
    # Haiku 4.5: cheapest current Claude that still handles tool calling well.
    vortex_model: str = Field(default="claude-haiku-4-5", alias="VORTEX_MODEL")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def bootstrap_staff_emails(self) -> list[str]:
        if not self.bootstrap_staff_emails_raw.strip():
            return []
        return [
            part.strip().lower()
            for part in self.bootstrap_staff_emails_raw.split(",")
            if part.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
