---
name: API Zod barrel
description: Prevent re-export collisions after regenerating OpenAPI operation schemas.
---

Keep the `api-zod` public barrel's response/domain types explicitly exported. Do not wildcard-export generated operation types alongside `generated/api`, because an operation parameter type can share a name with its generated Zod validator.

**Why:** Orval can add operation parameter interfaces under `generated/types` and re-add a wildcard export after codegen; TypeScript then reports duplicate exports such as `GetTeamDetailsParams`.

**How to apply:** When codegen adds operation parameters, preserve the Zod validator exports and strip the wildcard generated-types export in the codegen pipeline. Add only the intended domain/response types to the explicit export list.
