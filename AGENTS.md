# Agent Operating Rules

Behavioral guidelines tailored for LoopMaster SA3. These rules supplement and align with global operating standards.

---

## 1. Core Operating Principles
These core principles are inherited from global standards:
- **Think Before Coding**: Avoid assumptions. Surface tradeoffs and ask clarifying questions first.
- **Simplicity First**: Write the absolute minimum code required to solve the task. Avoid overcomplication.
- **Surgical Changes**: Edit only what is necessary. Match the existing style and clean up code orphans you introduce.
- **Goal-Driven Execution**: Define clear success criteria and verify changes systematically.

---

## 2. Project-Specific Workflows
- **Prompt Continuation**: Assume interrupted tasks are continuations of previous tasks unless instructed otherwise.
- **Artifact Updates**: Always keep plans and session trackers updated. Update `implementation.md`, `task.md`, `walkthrough.md`, and `HANDOFF.md` after every prompt completion.
- **New Files**: Open any new plans or `.md` files in the editor upon creation.

---

## 3. Governance & Standards
- **No Automated Tests without Approval**: NEVER run `pytest` or any automated testing commands (such as `pytest`, `python -m pytest`, etc.) on the user's machine without first asking for and obtaining their explicit permission.
- **Preserve Outputs Folder**: NEVER delete, alter, or clean up the `outputs/` folder or any generated audio files (.wav, .mp3, .ogg, etc.) within it. These files are user-managed and can only be manually deleted by the user.
- **SKILL.md Compliance**: When executing specialized technical tasks, follow the three levels of structure (Metadata, Logic, Execution) from the relevant `SKILL.md`.
- **AGENTS.md Alignment**: Strictly adhere to this project constitution. Flag any violations as "Architectural Violations" and seek authorization before proceeding.

---

## 4. Knowledge Base (Wiki)
Refer to the **[Knowledge Wiki](.wiki/_index.md)** at the project root for architectures, guidebooks, API specifications, and modulations mapping:
- Always check the wiki before performing research or implementation.
- Keep the wiki indexes and articles updated when discovering new patterns or completing significant milestones.

---

## 5. Handoff Documents
Always write the session handoff to **`HANDOFF.md` in the project root** (do NOT write it to any other location).
Rules for `HANDOFF.md`:
- Summarize the current conversation for subsequent agents.
- Include a "suggested skills" section.
- Refer to other artifacts by path or URL instead of duplicating content.
- Redact any sensitive information or credentials.
