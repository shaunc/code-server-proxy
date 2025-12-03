# Development Workflow

This guide covers the issue tracking and development workflow for code-server-proxy.

## Overview

We use a two-layer system for tracking work:

- **Beads**: Lightweight issue tracking that lives in `.beads/` - tracks _what_
  needs to be done
- **Planning Docs**: Markdown files in `tmp/issues/` - documents _why_ and
  provides detailed context

## Issue Tracking with Beads

### Finding Work

```bash
# Show tasks ready to work on (no blockers)
bd ready

# List all open issues
bd list --status=open

# List work in progress
bd list --status=in_progress

# View issue details with dependencies
bd show <issue-id>
```

### Working on Issues

```bash
# Claim work
bd update <id> --status=in_progress

# Mark complete
bd close <id>

# Close with explanation
bd close <id> --reason="Implemented X, tested with Y"
```

### Creating Issues

```bash
# Simple task
bd create --type=task --title="Implement feature X"

# Bug with description
bd create --type=bug --title="Fix crash in module Y" \
  --description="See: tmp/issues/bug-analysis/notes.md"

# Feature with planning doc reference
bd create --type=feature --title="Add parallel execution" \
  --description="See plan: tmp/issues/parallel-exec/plan.md"
```

### Dependencies

```bash
# Add blocker (issue A blocks issue B)
bd dep <issue-a> <issue-b>

# View blocked issues
bd blocked

# Project statistics
bd stats
```

## Planning Documentation

### Directory Structure

```
tmp/
  issues/
    <feature>/             # Feature planning subdirectory
      research.md          # Initial exploration
      architecture.md      # Technical design
      plan.md             # Implementation steps
    CLAUDE.md              # Quick notes for current work
```

### When to Use Planning Docs

Use `tmp/issues/` planning docs for:

- Research and exploration
- Architecture decisions
- Complex feature planning
- Design discussions requiring iteration
- Context that beads issues reference

Use beads issues for:

- Task tracking with clear scope
- Bug reports
- Small, well-defined features
- Status tracking and assignment
- Dependencies between tasks

### Planning Workflow

#### 1. Research Phase

Create `tmp/issues/<feature>/research.md`:

```markdown
# Feature Research

## Context

Why we're exploring this.

## Questions

1. What approaches exist?
2. What are the constraints?

## Findings

### Option A

...

## Open Questions

- ...
```

#### 2. Architecture Phase (if needed)

Add `architecture.md` for technical design decisions.

#### 3. Plan Phase

Create `plan.md` with concrete implementation steps:

```markdown
# Feature Implementation Plan

## Summary

One paragraph describing the feature.

## Prerequisites

- [ ] Dependency 1
- [ ] Dependency 2

## Implementation Steps

### Phase 1: Core Implementation

1. Step description
2. Step description

### Phase 2: Testing

1. Step description

## Testing Strategy

How we'll verify correctness.
```

#### 4. Issue Creation

Once the plan is approved:

```bash
# Create epic (for multi-issue features)
bd create --type=epic --title="Feature Name"

# Create tasks referencing the plan
bd create --type=task --title="Implement Phase 1" \
  --description="See: tmp/issues/<feature>/plan.md#phase-1"

# Link tasks to epic
bd dep <epic-id> <task-id> --type=parent-child
```

## Session Workflow

### Starting Work

```bash
bd ready                              # Find available work
bd show <id>                          # Review issue details
bd update <id> --status=in_progress   # Claim it
```

### Completing Work

```bash
bd close <id>                         # Mark done
git add . && git commit -m "..."      # Commit changes
```

### Discovering Additional Work

If you find additional work needed during implementation:

```bash
# Create new issue
bd create --title="<discovered work>"

# Link as dependency if it blocks current work
bd dep <new-id> <current-id>
```
