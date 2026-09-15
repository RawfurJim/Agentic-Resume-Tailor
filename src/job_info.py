"""
src/job_info.py
---------------
Two-agent job-description pipeline. The prompts live in text files:

    project/
    ├── .env                              DEEPSEEK_API_KEY=sk-...
    ├── prompts/
    │   ├── rewrite_job_description.txt   Agent 1 prompt
    │   └── extract_info.txt              Agent 2 prompt
    └── src/
        └── job_info.py                   this file

Setup:
    pip install langchain-core langchain-deepseek python-dotenv

Usage (run from the project folder):
    python src/job_info.py                      # quick test
    from src.job_info import ExtractJobInfo     # from another script
"""

import os
import json

from dotenv import load_dotenv
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_deepseek import ChatDeepSeek


# ---------------------------------------------------------------------------
# PATHS
# Everything is worked out from where THIS file lives, so it doesn't matter
# which folder you run the script from.
# ---------------------------------------------------------------------------
SRC_DIR      = os.path.dirname(os.path.abspath(__file__))   # .../project/src
PROJECT_ROOT = os.path.dirname(SRC_DIR)                      # .../project
PROMPTS_DIR  = os.path.join(PROJECT_ROOT, "prompts")         # .../project/prompts

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))              # .../project/.env


def load_prompt(file_name: str, prompts_dir: str = PROMPTS_DIR) -> str:
    """Read one prompt file from the prompts folder and return its text."""
    path = os.path.join(prompts_dir, file_name)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Prompt file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------------------
# THE CLASS
# ---------------------------------------------------------------------------
class ExtractJobInfo:
    """
    Agent 1 rewrites a job description as clean prose,
    Agent 2 extracts title / hard skills / soft skills from that prose,
    process() runs both and returns one combined dict.
    """

    def __init__(self, model_name="deepseek-chat", temperature=0,
                 api_key=None, prompts_dir=PROMPTS_DIR):
        # API key: use the one passed in, otherwise read it from .env
        api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
        if not api_key:
            raise ValueError(
                "DEEPSEEK_API_KEY not found. Add it to your .env file "
                "or pass api_key='...' when creating ExtractJobInfo."
            )

        # One LLM, shared by both agents (only the prompt differs)
        self.llm = ChatDeepSeek(model=model_name, temperature=temperature, api_key=api_key)

        # Load the prompt text from the .txt files
        rewrite_prompt = load_prompt("rewrite_job_description.txt", prompts_dir)
        extract_prompt = load_prompt("extract_info.txt", prompts_dir)

        # Each chain = prompt -> LLM -> plain string
        self.rewrite_chain = PromptTemplate.from_template(rewrite_prompt) | self.llm | StrOutputParser()
        self.extract_chain = PromptTemplate.from_template(extract_prompt) | self.llm | StrOutputParser()

    # ---- Agent 1 ----------------------------------------------------------
    def rewrite_as_prose(self, raw_job_description: str) -> str:
        """Agent 1: turn a messy job description into one clean paragraph."""
        return self.rewrite_chain.invoke({"job_description": raw_job_description}).strip()

    # ---- Agent 2 ----------------------------------------------------------
    def extract_skills(self, job_description: str) -> dict:
        """Agent 2: extract title, hard skills and soft skills as a dict."""
        raw_reply = self.extract_chain.invoke({"job_description": job_description})
        return self._parse_json(raw_reply)

    # ---- Full pipeline ----------------------------------------------------
    def process(self, raw_job_description: str) -> dict:
        """Run Agent 1 -> Agent 2 and return one combined dict."""
        if not raw_job_description or not raw_job_description.strip():
            raise ValueError("raw_job_description is empty.")

        cleaned_jd = self.rewrite_as_prose(raw_job_description)

        try:
            skills = self.extract_skills(cleaned_jd)
        except ValueError as e:
            # Agent 2 didn't return valid JSON -> report it instead of crashing
            return {"job_description": cleaned_jd, "error": str(e)}

        # Fixed keys in a fixed order, so every result has the same shape
        return {
            "job_description": cleaned_jd,
            "title": skills.get("title"),
            "Hard Skills": skills.get("Hard Skills", []),
            "Soft Skills": skills.get("Soft Skills", []),
        }

    def process_many(self, raw_job_descriptions) -> list:
        """Run process() on a list of JDs. One failure doesn't stop the rest."""
        results = []
        for i, jd in enumerate(raw_job_descriptions):
            try:
                results.append(self.process(jd))
            except Exception as e:                     # network error, empty text, ...
                print(f"[{i}] failed: {e}")
                results.append({"error": str(e)})
        return results

    # ---- Helper -----------------------------------------------------------
    @staticmethod
    def _parse_json(text: str) -> dict:
        """
        Turn the model's reply into a dict.
        Models sometimes wrap JSON in ```json ... ``` fences or add a sentence
        before it, so we keep only the part from the first '{' to the last '}'.
        """
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1:
            raise ValueError(f"Model reply did not contain JSON:\n{text}")
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError as e:
            raise ValueError(f"Model reply was not valid JSON ({e}):\n{text}") from e


# ---------------------------------------------------------------------------
# QUICK TEST  (runs only when you execute this file directly)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    sample_jd = """
    Senior Backend Engineer - Remote

    Responsibilities:
    - Design and build REST APIs in Python (Django or FastAPI)
    - Own our PostgreSQL schema and AWS infrastructure
    - Mentor junior developers

    Requirements:
    - 5+ years of backend experience
    - Docker, Kubernetes, CI/CD pipelines
    - Bachelor's degree in Computer Science or equivalent

    Nice to have:
    - Familiarity with LLM APIs (e.g. OpenAI)
    - Experience working in Agile, cross-functional teams
    """

    extractor = ExtractJobInfo()
    result = extractor.process(sample_jd)

    print(json.dumps(result, indent=2, ensure_ascii=False))