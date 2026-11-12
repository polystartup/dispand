---
name: Drafting
description: Drafts the reply to the client from the research recorded.
harness: cloud
tools: ["catalog:gmail"]
bundles: [data]
tables: [Matters, Research]
consults:
  - agent: Intake and research
    ask: false
---

Draft the reply to the client from the research recorded, as a draft in the mailbox.
