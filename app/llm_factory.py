"""
app/llm_factory.py
------------------
The only file that knows about provider differences.

    resolve_config(provider, model, api_key)  -> ModelConfig  (applies the defaults / rules)
    make_llm(provider, model, api_key)        -> LangChain chat model
    build_llms(config)                        -> (extract_llm, rewrite_llm)

Rules (see PLAN.md section 2):
    deepseek / blank : extract = deepseek-flash, rewrite = deepseek-reasoner.
                       An explicit model overrides BOTH slots.
                       Key = given key, else DEEPSEEK_API_KEY from .env / environment.
    gemini           : both slots = given model or gemini-2.5-flash.
                       Key is required; there is no .env fallback.
    anything else    : ConfigError.

The API key is never logged or printed by this module.
"""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# PATHS / ENV
# `.env` is loaded once at import time with override=False, so a variable that
# is already in os.environ (or one removed via monkeypatch in tests) wins.
# ---------------------------------------------------------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))       # .../project/app
PROJECT_ROOT = os.path.dirname(APP_DIR)                    # .../project
load_dotenv(os.path.join(PROJECT_ROOT, ".env"), override=False)


# ---------------------------------------------------------------------------
# DEFAULTS
# ---------------------------------------------------------------------------
DEFAULT_PROVIDER = "deepseek"
DEEPSEEK_EXTRACT_MODEL = "deepseek-flash"
DEEPSEEK_REWRITE_MODEL = "deepseek-reasoner"
GEMINI_DEFAULT_MODEL = "gemini-2.5-flash"

DEFAULTS = {
    "provider": DEFAULT_PROVIDER,
    "deepseek": {"extract_model": DEEPSEEK_EXTRACT_MODEL, "rewrite_model": DEEPSEEK_REWRITE_MODEL},
    "gemini": {"extract_model": GEMINI_DEFAULT_MODEL, "rewrite_model": GEMINI_DEFAULT_MODEL},
}

PROVIDERS = ("deepseek", "gemini")


class ConfigError(ValueError):
    """Raised when the user's provider / model / key choice cannot be used."""


@dataclass
class ModelConfig:
    provider: str
    extract_model: str
    rewrite_model: str
    api_key: str

    def __repr__(self) -> str:
        # Never expose the key in logs / tracebacks.
        return (
            f"ModelConfig(provider={self.provider!r}, extract_model={self.extract_model!r}, "
            f"rewrite_model={self.rewrite_model!r}, api_key='***')"
        )


def _clean(value: str | None) -> str | None:
    """Empty strings and whitespace count as 'not given'."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def resolve_config(provider: str | None, model: str | None, api_key: str | None,
                   env=os.environ) -> ModelConfig:
    """
    Turn the raw form values into a ModelConfig, filling in the defaults.

    `env` is the mapping used for the DeepSeek key fallback; tests can pass their
    own dict instead of os.environ.
    """
    provider = (_clean(provider) or DEFAULT_PROVIDER).lower()
    model = _clean(model)
    api_key = _clean(api_key)

    if provider == "deepseek":
        key = api_key or _clean(env.get("DEEPSEEK_API_KEY"))
        if not key:
            raise ConfigError(
                "No DeepSeek API key available. Add DEEPSEEK_API_KEY to .env or enter a key."
            )
        if model:
            extract_model = rewrite_model = model      # user override fills both slots
        else:
            extract_model = DEEPSEEK_EXTRACT_MODEL
            rewrite_model = DEEPSEEK_REWRITE_MODEL
        return ModelConfig(provider, extract_model, rewrite_model, key)

    if provider == "gemini":
        if not api_key:
            raise ConfigError("An API key is required for Gemini.")
        chosen = model or GEMINI_DEFAULT_MODEL
        return ModelConfig(provider, chosen, chosen, api_key)

    raise ConfigError(f"Unknown provider: {provider}")


def make_llm(provider: str, model: str, api_key: str, temperature: float = 0):
    """Build one LangChain chat model for the given provider."""
    provider = (provider or "").strip().lower()

    if provider == "deepseek":
        from langchain_deepseek import ChatDeepSeek
        return ChatDeepSeek(model=model, api_key=api_key, temperature=temperature)

    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(model=model, google_api_key=api_key, temperature=temperature)

    raise ConfigError(f"Unknown provider: {provider}")


def build_llms(config: ModelConfig, temperature: float = 0):
    """(extract_llm, rewrite_llm) for the two pipeline slots."""
    extract_llm = make_llm(config.provider, config.extract_model, config.api_key, temperature)
    rewrite_llm = make_llm(config.provider, config.rewrite_model, config.api_key, temperature)
    return extract_llm, rewrite_llm
