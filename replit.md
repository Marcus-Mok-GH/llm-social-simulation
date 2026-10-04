# LLM Social Simulation

Umbra Station is a browser-based social-deduction simulation with a live deck map, a controllable player, and autonomous crew and imposter agents.

## Run & Operate

- `pnpm --filter @workspace/llm-social-simulation run dev` — run the Umbra Station web app
- `pnpm --filter @workspace/llm-social-simulation run build` — create its static production bundle
- `pnpm --filter @workspace/llm-social-simulation run typecheck` — typecheck the web app
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `llm-social-simulation/` — unchanged GitHub clone, with its own `origin` remote
- `artifacts/llm-social-simulation/` — Replit web artifact built from the cloned source; static production settings are in `.replit-artifact/artifact.toml`
- `artifacts/api-server/` — shared API service
- `lib/api-spec/openapi.yaml` — API contract source of truth

## Architecture decisions

- The Replit web artifact is a static Vite deployment and does not require a server process in production.
- Convex is optional at runtime; the local simulation renders without a Convex deployment URL.

## Product

Players can explore the station deck and move their character while crewmates and imposters navigate the map.

## User preferences

No additional preferences recorded.

## Gotchas

- The frontend build expects `PORT` and `BASE_PATH`, supplied by the artifact workflow and publishing configuration.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
