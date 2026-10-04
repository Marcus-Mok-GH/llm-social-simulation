import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Phase 0 schema stub. Tables grow as game systems land (matches, players,
// agent memories, meeting transcripts) per PLAN.md phases 3-7.
export default defineSchema({
  players: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),
});
