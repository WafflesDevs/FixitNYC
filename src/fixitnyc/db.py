from functools import lru_cache

from supabase import Client, create_client
from supabase.lib.client_options import DEFAULT_HEADERS, SyncClientOptions
from supabase_auth import SyncMemoryStorage

from fixitnyc.config import get_settings


def _base_options() -> SyncClientOptions:
    return SyncClientOptions(
        auto_refresh_token=False,
        persist_session=False,
        storage=SyncMemoryStorage(),
        headers={**DEFAULT_HEADERS},
    )


@lru_cache
def get_service_client() -> Client:
    settings = get_settings()
    return create_client(
        settings.supabase_url,
        settings.supabase_secret_key,
        options=_base_options(),
    )


@lru_cache
def get_anon_client() -> Client:
    settings = get_settings()
    return create_client(
        settings.supabase_url,
        settings.supabase_publishable_key,
        options=_base_options(),
    )


def get_user_client(access_token: str) -> Client:
    """Client scoped to the caller's JWT so RLS policies apply."""
    settings = get_settings()
    client = create_client(
        settings.supabase_url,
        settings.supabase_publishable_key,
        options=_base_options(),
    )
    # Override after create: Client.__init__ replaces Authorization with the API key.
    client.options.headers["Authorization"] = f"Bearer {access_token}"
    client.postgrest.auth(access_token)
    return client
