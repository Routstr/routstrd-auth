import { describe, it, expect } from "bun:test";
import { AuthStore } from "./store";

// Usage summary forwarding tests:
// The auth proxy now forwards /usage and /usage/summary directly to the
// routstrd daemon with ?npub=<npub>. The daemon handles filtering, suffix
// stripping, and the full summary shape. Tests for getUsageSummary were
// removed from here — they live in the routstrd daemon's test suite.
