"""
src/update_cv.py
----------------
Rewrites your CV to match a job, using the dict produced by
ExtractJobInfo.process() (job_info.py). Two agents, both fed the cleaned
job description from that dict:

    Agent 1  rewrite_title_skills   ->  title, profile, skills, role
                                        (also gets the job's Hard/Soft Skills)
    Agent 2  rewrite_experience     ->  experience (project titles + bullets)

    process()          merges both into one dict, same shape as cv_map.json
    process_and_save() does the same and writes it to updated_cv.json

Files this class reads (all relative to the project folder):

    project/
    ├── .env                          DEEPSEEK_API_KEY=sk-...
    ├── cv_map.json                   your current CV (title, profile, skills, role, experience)
    ├── profile.md                    detailed background      -> extra context for Agent 1
    ├── profile_experience.md         detailed project write-ups -> extra context for Agent 2
    ├── prompts/
    │   ├── rewrite_title_skills.txt  Agent 1 prompt
    │   └── rewrite_experience.txt    Agent 2 prompt
    └── src/
        ├── job_info.py
        ├── update_cv.py              this file
        └── main.py                   runs job_info -> update_cv end to end

Usage (run from the project folder):
    python src/update_cv.py            # quick test with a sample job_info
    python src/main.py                 # full pipeline
"""

import os
import json

from dotenv import load_dotenv
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_deepseek import ChatDeepSeek


# ---------------------------------------------------------------------------
# PATHS  (worked out from where THIS file lives, so the working dir doesn't matter)
# ---------------------------------------------------------------------------
SRC_DIR      = os.path.dirname(os.path.abspath(__file__))    # .../project/src
PROJECT_ROOT = os.path.dirname(SRC_DIR)                       # .../project
PROMPTS_DIR  = os.path.join(PROJECT_ROOT, "prompts")

CV_MAP_PATH             = os.path.join(PROJECT_ROOT, "cv_map.json")
PROFILE_PATH            = os.path.join(PROJECT_ROOT, "profile.md")
PROFILE_EXPERIENCE_PATH = os.path.join(PROJECT_ROOT, "profile_experience.md")
UPDATED_CV_PATH         = os.path.join(PROJECT_ROOT, "updated_cv.json")

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))


# ---------------------------------------------------------------------------
# SMALL HELPERS
# ---------------------------------------------------------------------------
def read_file(path: str) -> str:
    """Read any text file (prompt, .md, .json) and return its contents."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def load_prompt(file_name: str) -> str:
    """Read one prompt from the prompts folder."""
    return read_file(os.path.join(PROMPTS_DIR, file_name))


def to_pretty_json(data) -> str:
    """dict -> indented JSON string (this is what gets pasted into the prompts)."""
    return json.dumps(data, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# THE CLASS
# ---------------------------------------------------------------------------
class UpdateCv:
    """Rewrites cv_map.json to match the job described in a job_info dict."""

    def __init__(self, model_name="deepseek-reasoner", temperature=0, api_key=None, llm=None):
        if llm is not None:
            # A ready-made LangChain chat model was injected (e.g. by the web app)
            self.llm = llm
        else:
            # API key: use the one passed in, otherwise read it from .env
            api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
            if not api_key:
                raise ValueError(
                    "DEEPSEEK_API_KEY not found. Add it to your .env file "
                    "or pass api_key='...' when creating UpdateCv."
                )

            # One LLM, shared by both agents (only the prompt differs)
            self.llm = ChatDeepSeek(model=model_name, temperature=temperature, api_key=api_key)

        # Your current CV + the two detailed background files (loaded once)
        self.cv_map             = json.loads(read_file(CV_MAP_PATH))
        self.profile            = read_file(PROFILE_PATH)
        self.profile_experience = read_file(PROFILE_EXPERIENCE_PATH)

        # Each chain = prompt -> LLM -> plain string
        self.title_skills_chain = (
            PromptTemplate.from_template(load_prompt("rewrite_title_skills.txt"))
            | self.llm | StrOutputParser()
        )
        self.experience_chain = (
            PromptTemplate.from_template(load_prompt("rewrite_experience.txt"))
            | self.llm | StrOutputParser()
        )

    # ---- Agent 1 ----------------------------------------------------------
    def rewrite_title_skills(self, job_info: dict) -> dict:
        """Agent 1: rewrite title / profile / skills / role for the target job."""
        current_cv = {key: self.cv_map.get(key) for key in ("title", "profile", "skills", "role")}
        target_skills = {
            "Hard Skills": job_info.get("Hard Skills", []),
            "Soft Skills": job_info.get("Soft Skills", []),
        }

        raw_reply = self.title_skills_chain.invoke({
            "job_description": job_info["job_description"],
            "target_skills": to_pretty_json(target_skills),
            "current_cv_summary": to_pretty_json(current_cv),
            "detailed_experience_and_projects": self.profile,
        })
        return self._parse_json(raw_reply)

    # ---- Agent 2 ----------------------------------------------------------
    def rewrite_experience(self, job_info: dict) -> dict:
        """Agent 2: rewrite the experience section (project titles + bullets)."""
        current_cv = {"experience": self.cv_map.get("experience", [])}

        raw_reply = self.experience_chain.invoke({
            "job_description": job_info["job_description"],
            "current_cv_summary": to_pretty_json(current_cv),
            "detailed_experience_and_projects": self.profile_experience,
        })
        return self._parse_json(raw_reply)

    # ---- Full pipeline ----------------------------------------------------
    def process(self, job_info: dict) -> dict:
        """
        job_info = the dict returned by ExtractJobInfo.process().
        Runs Agent 1 and Agent 2 and returns the updated CV as one dict.
        """
        if not (job_info.get("job_description") or "").strip():
            raise ValueError("job_info['job_description'] is empty.")

        top_part   = self.rewrite_title_skills(job_info)   # title, profile, skills, role
        experience = self.rewrite_experience(job_info)     # experience

        # Same keys, same order as cv_map.json
        return {
            "title": top_part.get("title"),
            "profile": top_part.get("profile"),
            "skills": top_part.get("skills", []),
            "role": top_part.get("role"),
            "experience": experience.get("experience", []),
        }

    def process_and_save(self, job_info: dict, output_path: str = UPDATED_CV_PATH) -> dict:
        """process() and also write the result to updated_cv.json."""
        updated_cv = self.process(job_info)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(to_pretty_json(updated_cv))
        print(f"Saved -> {output_path}")
        return updated_cv

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
    # Same shape as ExtractJobInfo.process() returns. Hard-coded here so you
    # can test the CV rewrite without re-running job_info.py each time.
    sample_job_info = {
        "job_description": (
            "We are hiring a Senior AI Engineer to build and deploy production "
            "LLM systems, including multi-agent pipelines, RAG, and fine-tuned "
            "open-source models running on self-hosted GPUs."
        ),
        "title": "Senior AI Engineer",
        "Hard Skills": ["LLM fine-tuning", "RAG", "Multi-agent systems", "Docker", "GPU serving"],
        "Soft Skills": ["Stakeholder communication", "Mentoring"],
    }

    updater = UpdateCv()
    result = updater.process_and_save(sample_job_info)

    print(json.dumps(result, indent=2, ensure_ascii=False))