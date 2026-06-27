/** AC-02: dagre layout — linear chains stack straight; cycles/branches don't throw. */
import { describe, it, expect } from "vitest";
import { dagreLayout } from "./layout";

const size = () => ({ w: 190, h: 48 });

describe("dagreLayout", () => {
  it("lays a linear chain straight down (same x, increasing y, no fold)", () => {
    const nodes = ["a", "b", "c"];
    const edges: [string, string][] = [["a", "b"], ["b", "c"]];
    const pos = dagreLayout(nodes, edges, size);
    expect(pos.a.x).toBeCloseTo(pos.b.x);          // single child sits directly below
    expect(pos.b.x).toBeCloseTo(pos.c.x);
    expect(pos.a.y).toBeLessThan(pos.b.y);         // top-to-bottom
    expect(pos.b.y).toBeLessThan(pos.c.y);
  });

  it("handles a branch (two children spread apart on the next rank)", () => {
    const pos = dagreLayout(["g", "x", "y"], [["g", "x"], ["g", "y"]], size);
    expect(pos.x.y).toBeCloseTo(pos.y.y);          // siblings share a rank
    expect(pos.x.x).not.toBeCloseTo(pos.y.x);      // ...spread horizontally
  });

  it("does not throw on a cycle (loop / back edge)", () => {
    const pos = dagreLayout(
      ["a", "b", "c"],
      [["a", "b"], ["b", "c"], ["c", "b"]],        // c -> b is a back edge
      size,
    );
    expect(Object.keys(pos)).toEqual(["a", "b", "c"]);  // every node placed
  });
});
