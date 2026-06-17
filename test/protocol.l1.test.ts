/** L1 contract round-trip (TS side). Same golden JSON as tests/test_protocol_l1.py. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ServerEvent, ClientCommand } from "../protocol";

const here = fileURLToPath(new URL(".", import.meta.url));
const wire = (n: string) => JSON.parse(readFileSync(`${here}wire/${n}.json`, "utf-8"));

const serverCases = ["graph", "run_started", "node_start", "node_end", "run_finished"];
const clientCases = ["start_run"];

describe("L1 round-trip (TS zod mirror)", () => {
  for (const n of serverCases) {
    it(`ServerEvent ${n} parses and equals golden`, () => {
      const g = wire(n);
      expect(ServerEvent.parse(g)).toEqual(g);
    });
  }
  for (const n of clientCases) {
    it(`ClientCommand ${n} parses and equals golden`, () => {
      const g = wire(n);
      expect(ClientCommand.parse(g)).toEqual(g);
    });
  }
});
