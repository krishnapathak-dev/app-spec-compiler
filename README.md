# app-spec-compiler
So this is my submission for the AI Engineer internship demo task. What I built is an App Spec Compiler — a system that takes a plain English description of an app and converts it into a complete, structured configuration that could actually run a product. No manual fixes, no guesswork. Let me walk you through how it works.
# App Spec Compiler

A multi-stage AI pipeline that converts natural language into a complete,
executable app specification — like a compiler for software generation.

## Pipeline Stages
1. Intent Extraction — parses user prompt into structured JSON
2. System Design — converts intent into entities, flows, pages, roles
3. Schema Generation — produces DB, API, UI, and Auth schemas
4. Refinement & Repair — cross-checks all layers and fixes inconsistencies
5. Validation — programmatic checks with auto-repair

## Tech Stack
- React (frontend)
- Anthropic Claude API (claude-sonnet-4-6)
- Multi-stage structured prompting

## How to Run
Open app-compiler.jsx in any React environment or paste into claude.ai artifacts.

## Demo
Enter any app description and the system compiles a full spec in under 30 seconds.
