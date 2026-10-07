import { techDebtTest } from "./testing/techDebt.ts";

techDebtTest(
  new Date("2026-10-13T20:37:51.000Z"),
  "The braces audit exception expired. Check https://github.com/advisories/GHSA-vfj7-8cjw-p6xm for a patched release, update bun.lock, and remove the audit ignore.",
);
