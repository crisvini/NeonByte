# Instructions for Coding Agents

1. Read all of `PLANNING.md`, this file, and related documentation before changing the project.
2. Execute only the phase explicitly authorized by the maintainer. Do not advance to future phases.
3. Treat hardware, pinout, memory, flash, partitions, OTA, and recovery as PENDING when unsupported by evidence. Do not infer compatibility from a product name.
4. Do not compile for an assumed board or perform flash, OTA, erase, partition changes, or any device operation without explicit authorization.
5. Never commit tokens, secrets, passwords, real `.env` files, or Spotify credentials. Use `.env.example` only for non-secret names and placeholders.
6. Keep the contracts in `contracts/v1/` aligned with `docs/protocol.md`; update examples and tests when a contract changes.
7. Run `npm run check` to validate Markdown and contracts before completing a phase.
8. Mark tasks in `PLANNING.md` complete only after they are verified. Stop at the authorized phase boundary and request approval before continuing.

## Conventions

### Language and Naming Conventions

These conventions apply to every future development phase, refactoring, bug fix, and contribution.

1. Write all source code in English.
2. Use descriptive English names for all identifiers.
3. Use English for all filenames and directory names.
4. Write all comments, documentation, and test descriptions in English.
5. Write all logs, error messages, and UI text in English.
6. Use American English (`en-US`) consistently.
7. Prefer `camelCase` for variables and functions, `PascalCase` for classes and types, and `UPPER_SNAKE_CASE` for constants where appropriate.
8. Follow the naming conventions of the existing framework and ecosystem.
9. Do not introduce Portuguese or mixed-language content.
10. Verify compliance with these rules before completing any development task.

### Initial Conventions

- Use UTF-8 encoding and LF line endings.
- Format Markdown with hierarchical headings, hyphenated lists, and fenced code blocks.
- Do not add runtime dependencies without a documented need.
- Do not implement agent, firmware, or simulator code until its phase is authorized.
