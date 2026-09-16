"""Config resolution and provider selection. No network calls."""

import pytest
from langchain_deepseek import ChatDeepSeek
from langchain_google_genai import ChatGoogleGenerativeAI

from app.llm_factory import (
    DEEPSEEK_EXTRACT_MODEL,
    DEEPSEEK_REWRITE_MODEL,
    GEMINI_DEFAULT_MODEL,
    ConfigError,
    ModelConfig,
    build_llms,
    make_llm,
    resolve_config,
)
from app.pipeline import safe_filename


# ---------------------------------------------------------------------------
# resolve_config
# ---------------------------------------------------------------------------
def test_default_resolves_to_flash_and_reasoner_with_env_key():
    config = resolve_config(None, None, None)
    assert config.provider == "deepseek"
    assert config.extract_model == DEEPSEEK_EXTRACT_MODEL == "deepseek-flash"
    assert config.rewrite_model == DEEPSEEK_REWRITE_MODEL == "deepseek-reasoner"
    assert config.api_key                      # came from .env


def test_blank_strings_behave_like_none():
    config = resolve_config("  ", "", "   ")
    assert config.provider == "deepseek"
    assert config.extract_model == "deepseek-flash"
    assert config.rewrite_model == "deepseek-reasoner"


def test_deepseek_explicit_model_fills_both_slots():
    config = resolve_config("DeepSeek", "deepseek-reasoner", "sk-test")
    assert config.provider == "deepseek"
    assert config.extract_model == "deepseek-reasoner"
    assert config.rewrite_model == "deepseek-reasoner"
    assert config.api_key == "sk-test"


def test_deepseek_given_key_beats_env_key():
    config = resolve_config("deepseek", None, "sk-given", env={"DEEPSEEK_API_KEY": "sk-env"})
    assert config.api_key == "sk-given"


def test_deepseek_without_any_key_raises(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(ConfigError, match="No DeepSeek API key available"):
        resolve_config("deepseek", None, None)
    # and the same via an explicit empty env mapping
    with pytest.raises(ConfigError, match="No DeepSeek API key available"):
        resolve_config(None, None, "", env={})


def test_gemini_with_key_and_model_uses_model_for_both_slots():
    config = resolve_config("gemini", "gemini-2.5-pro", "g-key")
    assert config.provider == "gemini"
    assert config.extract_model == "gemini-2.5-pro"
    assert config.rewrite_model == "gemini-2.5-pro"
    assert config.api_key == "g-key"


def test_gemini_without_model_uses_default():
    config = resolve_config("Gemini", None, "g-key")
    assert config.extract_model == GEMINI_DEFAULT_MODEL == "gemini-2.5-flash"
    assert config.rewrite_model == "gemini-2.5-flash"


def test_gemini_without_key_raises(monkeypatch):
    # Even with a DeepSeek key in the environment, Gemini must not fall back to it.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-should-not-be-used")
    with pytest.raises(ConfigError, match="An API key is required for Gemini"):
        resolve_config("gemini", "gemini-2.5-flash", None)
    with pytest.raises(ConfigError, match="An API key is required for Gemini"):
        resolve_config("gemini", None, "   ")


def test_unknown_provider_raises():
    with pytest.raises(ConfigError, match="Unknown provider: openai"):
        resolve_config("openai", "gpt-4o", "some-key")


def test_config_repr_hides_key():
    config = ModelConfig("deepseek", "a", "b", "sk-secret-value")
    assert "sk-secret-value" not in repr(config)


# ---------------------------------------------------------------------------
# make_llm / build_llms
# ---------------------------------------------------------------------------
def test_make_llm_returns_deepseek_class():
    llm = make_llm("deepseek", "deepseek-flash", "sk-test")
    assert isinstance(llm, ChatDeepSeek)
    assert llm.model_name == "deepseek-flash"


def test_make_llm_returns_gemini_class():
    llm = make_llm("gemini", "gemini-2.5-flash", "g-key")
    assert isinstance(llm, ChatGoogleGenerativeAI)
    assert "gemini-2.5-flash" in llm.model


def test_make_llm_unknown_provider_raises():
    with pytest.raises(ConfigError):
        make_llm("openai", "gpt-4o", "k")


def test_build_llms_uses_both_slots():
    config = resolve_config("deepseek", None, "sk-test")
    extract_llm, rewrite_llm = build_llms(config)
    assert isinstance(extract_llm, ChatDeepSeek) and isinstance(rewrite_llm, ChatDeepSeek)
    assert extract_llm.model_name == "deepseek-flash"
    assert rewrite_llm.model_name == "deepseek-reasoner"


# ---------------------------------------------------------------------------
# safe_filename
# ---------------------------------------------------------------------------
def test_safe_filename_basic():
    assert safe_filename("Senior AI Engineer / ML") == "Md_Rawfur_Monzur_Jim_CV_Senior_AI_Engineer_ML.docx"


def test_safe_filename_collapses_and_trims():
    assert safe_filename("  Data   Scientist (NLP) ") == "Md_Rawfur_Monzur_Jim_CV_Data_Scientist_NLP.docx"
    assert safe_filename("Back-End Dev") == "Md_Rawfur_Monzur_Jim_CV_Back-End_Dev.docx"


def test_safe_filename_empty_and_long():
    assert safe_filename("") == "Md_Rawfur_Monzur_Jim_CV_CV.docx"
    long_name = safe_filename("A" * 200)
    title_part = long_name[len("Md_Rawfur_Monzur_Jim_CV_"):-len(".docx")]
    assert len(title_part) == 60


# ---------------------------------------------------------------------------
# write_docx (stage 3 only, no network) using the checked-in updated_cv.json
# ---------------------------------------------------------------------------
def test_write_docx_builds_a_docx_next_to_output(tmp_path):
    import json
    import docx
    from app.pipeline import PROJECT_ROOT, MASTER_CV, write_docx

    with open(f"{PROJECT_ROOT}/updated_cv.json", encoding="utf-8") as f:
        updated_cv = json.load(f)

    out = tmp_path / "out.docx"
    assert write_docx(updated_cv, str(out)) == str(out)
    assert out.exists()
    texts = [p.text for p in docx.Document(str(out)).paragraphs if p.text.strip()]
    assert updated_cv["title"].replace("**", "") == texts[1]   # bold markers are stripped in the docx
    assert list(tmp_path.iterdir()) == [out]          # temp folder was cleaned up


def test_write_docx_bad_shape_is_a_parse_error(tmp_path):
    from app.pipeline import PipelineError, write_docx

    with pytest.raises(PipelineError) as exc:
        write_docx({"title": "x"}, str(tmp_path / "out.docx"))
    assert exc.value.kind == "parse"
