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

---

## 6. Codebase Knowledge Graph (codebase-memory-mcp)

This project uses `codebase-memory-mcp` to maintain a knowledge graph of the codebase. When the MCP server is configured and running:

- **ALWAYS** prefer MCP graph tools over grep/glob/file-search for code discovery.
- **Priority Order**:
  1. `search_graph` — find functions, classes, routes, variables by pattern
  2. `trace_path` — trace who calls a function or what it calls
  3. `get_code_snippet` — read specific function/class source code
  4. `query_graph` — run Cypher queries for complex patterns
  5. `get_architecture` — high-level project summary
- **When to fall back to grep/glob**:
  - Searching for string literals, error messages, config values
  - Searching non-code files (Dockerfiles, shell scripts, configs)
  - When MCP tools return insufficient results
- **Pre-flight Check**: Check if the MCP server is running. If it is not, report it to the user and request to use/configure it.

---

## 7. Local Knowledge Base (.wiki/)

This project's local knowledge base now lives at `.wiki/` (migrated from loose root-level raw/wiki/inbox/output/log.md/_index.md) — start at `.wiki/_index.md`. Immutable source material lives in `.wiki/raw/`; synthesized docs live in `.wiki/wiki/{concepts,topics,references,theses}/`. Append operations to `.wiki/log.md` (never edit past entries).
