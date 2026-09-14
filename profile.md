PROFESSIONAL SUMMARY
I am working in judgeservice for almost 3 years.. i am leadinf thiar ai transformation . i have integrated ai into existing product also created new ai product as well. 


PROFESSIONAL EXPERIENCE
AI Engineer — JudgeService Research Ltd	 Jan 2024 to Present
 
"Multi-Agent Sentiment Analysis Pipeline",

I designed and built the multi-agent LLM pipeline behind two client-facing sentiment analysis products at JudgeService — a general review-insight dashboard and a sister service focused specifically on negative reviews — both of which turn raw, unstructured customer reviews into structured, dashboard-ready JSON. Rather than one large prompt, I split the analysis into six single-purpose agents in a fixed chain: a type classifier (Sales/Servicing/Other), a subtype detector that narrows further by keyword, an analyzer that identifies specific categories and subcategories and assigns per-topic sentiment, an evidence-extraction step that grounds every sentiment label in an exact quote from the review, a staff-name linker that attributes sentiment to specific named employees rather than the review as a whole, and an independent overall-sentiment pass. Two pipelines run behind this chain — the Gemini API for latency-sensitive single-review requests, and a self-hosted open-weights model served through Ollama for large batch jobs — with simple urgency-based routing between them, which keeps high-volume work off the paid API and is the main lever I have on unit cost.

Because the output feeds dashboards directly, I put real engineering effort into making the JSON layer bulletproof: a JSON-extraction step that recovers clean JSON even when the model wraps it in markdown, a fuzzy-matching layer that snaps any subcategory name onto the exact taxonomy label and drops anything that can't be confidently matched rather than passing it through, a fixed output schema so every response has the same keys whether or not data is present, a loop guard against runaway regeneration, and a conditional keyword layer for industry jargon (like "PCP" or "MOT") that I feed into the prompt as advisory signal rather than a hard override, since an early hard-override version proved brittle. All of it sits behind a two-tier test suite — fast unit tests on the deterministic components, and a regression suite that reruns a hand-labeled hard-case evaluation set and fails the CI build if precision or recall drops below threshold — plus schema, taxonomy-validity, evidence-grounding, and edge-case tests, so a bad prompt change gets caught before it ships.

The model-serving side went through a real evolution. It started as one local model serving every agent; as the second product came online, I experimented with tiering three different model sizes across the six agents by task difficulty — a larger model on the harder, nuanced steps, smaller ones on simpler classification steps. That sounds efficient in principle, but it meant up to three distinct models had to stay resident in GPU memory at once, and across two products that consumed effectively the entire 48GB card, leaving the two products unable to run concurrently at all. I resolved this by consolidating everything — both products, all six agents — onto a single self-hosted model (Gemma 4 31B), which freed over 10GB of VRAM and, more importantly, removed the mutual exclusion between the two products entirely. On top of that I tuned concurrency directly: enabling Ollama's parallel request handling and KV-cache reuse, and moving the latency-critical single-review endpoint from strictly one-request-at-a-time to two concurrent requests, roughly doubling its effective throughput without touching hardware.

I also own the reliability of the self-hosted serving layer end to end. I hit real production incidents along the way — GPU out-of-memory errors from running four or five agents concurrently against one model, fixed by sequencing agent execution with a delay between the heavier calls that I tuned experimentally rather than guessed — and unpredictable multi-second slowdowns caused by Ollama unloading an idle model after five minutes and cold-starting on the next burst of traffic, fixed by pinning the model in GPU memory permanently via a persistent Docker Compose deployment. Most recently I built a proper high-availability layer: two self-hosted model server instances behind HAProxy, which health-checks both and routes to whichever is live; each instance attempts to auto-restart on failure; and a tiered alerting system emails me and engineering leadership the moment an instance goes down and starts recovering, then escalates to a "needs human intervention" email if three consecutive automated restart attempts fail — so routine self-healing stays quiet, but a genuine outage always surfaces fast.

On the modeling side, separate from infra, I pushed subcategory recall on hard cases (sarcasm, mixed sentiment, multi-topic reviews) from roughly 0.84 to 0.96 (0.98 F1) by isolating the specific failure mode experimentally — a smaller model was precise but incomplete, not wrong — and fixing it with a larger model plus few-shot prompting, measured against a hand-labeled 113-review evaluation set built specifically to stress the hard cases. Taken together, this pipeline now contributes to a 20% lift in client retention on the insight-dashboard product.


AI-Powered Review Response System (Live Across Major UK Dealer Groups)

I built and shipped an LLM-based review-response service for car dealerships end to end — the kind of system where the model's output is customer-facing text going straight onto a public review, so reliability and per-client correctness mattered as much as raw generation quality. Given a customer review, the service first runs it through a sentiment check (positive or negative), since a happy-customer reply and an unhappy-customer reply need completely different tone and content, and each branch uses its own prompt set. From there it generates three reply options — a detailed personal one, a general professional one, and a short one — and the dealer picks whichever fits and publishes it. Every dealership also gets its own baked-in rules: for example, one client wanted their contact email included in every reply, which I implemented as a standing instruction in their prompt.

The hardest engineering problem came from a different dealership's rule: their brand name had to appear an exact number of times in every reply. The base model I was running, Llama 3 8B, simply couldn't hold that constraint reliably — it would land on two mentions one time and four the next, and no amount of prompt rewriting fixed it consistently, which told me this was a genuine capability gap in the small model rather than a prompting problem. I solved it with knowledge distillation: I used a much larger Llama 3 70B model, which could follow the rule properly, to generate a set of high-quality example replies that satisfied the constraint exactly, then fine-tuned my 8B model on that data using LoRA and QLoRA via the Unsloth library. That let the small model inherit the large model's reliability on this specific behavior while keeping the 8B model's inference speed and cost in production.

On the infrastructure side, I containerized the whole service with Docker and exposed it as a REST API through FastAPI. I deployed it myself on AWS EC2 first, configuring the NVIDIA GPU drivers and Linux environment from scratch, and once the company had its own AI server in-house, I led the migration to on-prem to cut running costs. I later added database-level caching for repeat requests, so an identical or near-identical review doesn't trigger a redundant model call, which cut both cost and response time further.

Because "a good reply" is genuinely subjective and varies by dealership, evaluation leaned heavily on human review — but I didn't want every bad draft reaching a human, so I put rule-based checks and an LLM-as-a-judge step in front of it as an automated first filter, catching obviously bad output before anyone saw it. The three-option format also gave me a feedback loop for free: since the dealer has to pick one of three every time, which option they choose is a signal about which style is actually working, with no extra instrumentation needed.

The system is live across several major UK dealer groups, processing upwards of 100k reviews a month, and about 93% of drafts go out with no edit at all — the number I actually trust most as a measure of whether the model is doing its job. It's also brought in roughly £50k in recurring revenue. If I'm honest about what I'd change: I originally gave each dealership its own API endpoint to onboard them quickly, which worked but left me with repetitive, duplicated code across endpoints; the cleaner version would be a single endpoint driven by a per-dealer config file, so onboarding a new dealership becomes a config change instead of new code — something worth prioritizing now that the pattern has proven out.


RAG Documentation Engine


"In my recent project, I tackled a major bottleneck for our team: we had large, legacy PHP and JavaScript codebases with almost zero documentation. It was eating up developer hours and making onboarding new engineers painfully slow. To fix this, I built an automated, privacy-first code documenter using a Retrieval-Augmented Generation, or RAG, pipeline running entirely locally.
I approached the build in three main phases. First, I needed to give the AI a way to actually 'read' and search the codebase. I used LangChain to ingest the files, chunked them into 2,000-character segments, and used the Linq-Embed-Mistral model to convert them into vector embeddings, which I stored in a local Chroma database.
Once that 'brain' was set up, I built the RAG generation process. For every code chunk, the system queried Chroma for related context—so if a function called something in another file, the AI understood the link. I fed this context and the code into a local LLaMA 3 model using Ollama to draft the initial documentation.
One interesting challenge here was hardware limitations. Generating docs for thousands of files was crashing my machine. To get around this, I engineered a memory management safeguard using PyTorch to explicitly clear the GPU cache every few chunks and introduced micro-pauses. This made the pipeline completely stable.
From there, I ran a refinement pass. I fed the raw AI drafts back into LLaMA 3, this time prompting it to act as a '10x Technical Writer' to strip out AI fluff and format everything perfectly in Markdown. Finally, I refactored the entire pipeline into clean, Object-Oriented Python so it's highly modular.
The business impact was immediate: we reduced manual documentation overhead by 90% and completely transformed our onboarding process, allowing new hires to get up to speed in a fraction of the time."


work with STT :: 

Developed an automated call-quality assessment tool using WhisperX transcription (STT) and rule-based LLM analysis, replacing manual QA audits.

Gave AI Training::   


Ran internal workshops on LLM capabilities and prompt engineering, accelerating adoption of AI tooling across the development team.


personal projects::  


ResumeTailor (Built with Claude & Jira)
•	Engineered a six-agent pipeline (Gemini Flash) that analyzes job descriptions against a candidate’s real experience to precisely rewrite CV summaries and skills, boosting ATS without inventing missing skills.
•	Built an independent reviewer agent to ensure accuracy by checking the rewrite against the original CV, automatically blocking AI hallucinations, restoring dropped metrics, and perfectly preserving the original Word document formatting.
•	Shipped 3,700 lines of tested Python in a single day using Claude Code to autonomously write product requirements, create 10 sequential Jira tickets via Atlassian MCP, and implement the code alongside 141 offline tests.



ResumeBoost: A Machine Learning-Based Resume Optimizer [GitHub]
•	Developed ResumeBoost using Active Learning and Machine Learning techniques, aiding candidates in enhancing resumes with real-time feedback, sourced data via web scraping from Indeed and Glassdoor.
•	Established a CI/CD pipeline using GitHub Actions, Heroku, SQL and NoSQL databases; utilized Spacy for NER and Docker for cross-environment reliability.
•	Incorporated Active Learning into the system, allowing for continuous model improvement. This feature, combined with the Flask web interface, facilitates dynamic, real-time resume improvement suggestions.

Predictive Model for Student's Mathematics Performance [GitHub]
•	Designed a predictive model using machine learning algorithms and data science techniques, exhibiting exceptional problem-solving skills and innovation.
•	Utilized and Hyperparameter-tuned various algorithms and predict (RandomForest, DecisionTree, GradientBoosting, Linear Regression, XGBRegressor, CatBoosting, AdaBoost) for optimal results and showcasing my dedication in problem solving.


Personalized Diet Recommendation System [GitHub] 
•	Leveraging Machine Learning, this system offers a Personalized Diet Recommendation System, fed by real-world data, with a robust CI/CD pipeline using GitHub Actions and Heroku for efficient integration, testing, and deployment. 
•	Used Docker for consistent functionality across environments, it uses the K-nearest Neighbors algorithm to tailor diet advice considering user metrics like age, height, weight, gender, activity level, BMI, and BMR.
•	A Flask web interface facilitates user interaction, dynamically integrating API-fed data for precise, real-time nutritional advice, elevating it beyond a mere dietary guide to a promoter of healthier lifestyle choices.

Data Warehouse for Government Spending Insights [GitHub]
•	Developed a data warehouse to analyze government spending patterns, facilitating data-driven decision-making for resource allocation.
•	Employed SQL for extracting, transforming, and loading data, pre-processing, and organizing it into a star schema platform for optimal query performance. Performed data analysis tasks and integrated the data with Power BI. 
•	Successfully pinpointed areas of high and low spending across various departments, enabling strategic budget adjustments and informed policy recommendations.


Multimodal Fusion to Detect Sarcasm [GitHub]
•	Successfully extracted images, comments, and likes from a screenshot dataset using OpenCV and EasyOCR, featuring humorous images with the top three amusing comments.
•	Created a Multimodal Model incorporating NLP (Bert, Fast-Text) for comments, Computer Vision (ResNet) for images, and Fusion to merge both outcomes, effectively rating sarcasm or irony.
•	Collaborated seamlessly with the Facebook group Commenti Memorabili to conduct thorough research on their data.


UK Inflation Impact Analysis [GitHub]
•	Led the UK Inflation Impact Analysis Project, focused on examining the effects of inflation on different sectors and its recent consequences on people's lives.
•	Employed Microsoft Excel, Python Pandas for data cleansing, Power Query for establishing relationships and restructuring data, and DAX for creating critical measures. Utilized Power BI for data visualization, delivering valuable insights.
•	Identified the primary factors driving inflation trends and ongoing strikes, showcasing data manipulation and visualization skills.



