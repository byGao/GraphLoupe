/** AC-02: ELK layout — top-to-bottom, orthogonal edge routes, cycles don't throw. */
import { describe, it, expect } from "vitest";
import { elkLayout, type Pt } from "./layout";

const size = () => ({ w: 190, h: 48 });
const axisAligned = (pts: Pt[]) =>
  pts.slice(1).every((p, i) => Math.abs(p.x - pts[i].x) < 0.5 || Math.abs(p.y - pts[i].y) < 0.5);

describe("elkLayout", () => {
  it("lays a linear chain top-to-bottom with orthogonal routes", async () => {
    const { pos, routes } = await elkLayout(["a", "b", "c"], [["a", "b"], ["b", "c"]], size);
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.c.y);
    expect(routes["a->b"].length).toBeGreaterThanOrEqual(2);
    expect(axisAligned(routes["a->b"])).toBe(true);   // every segment is H or V (no diagonal)
    expect(axisAligned(routes["b->c"])).toBe(true);
  });

  it("routes a branch's two edges (both present, orthogonal)", async () => {
    const { routes } = await elkLayout(["g", "x", "y"], [["g", "x"], ["g", "y"]], size);
    expect(axisAligned(routes["g->x"])).toBe(true);
    expect(axisAligned(routes["g->y"])).toBe(true);
  });

  it("handles a cycle (loop / back edge) without throwing; forward & back routes differ", async () => {
    const { pos, routes } = await elkLayout(
      ["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "b"]], size,
    );
    expect(Object.keys(pos)).toEqual(["a", "b", "c"]);
    expect(routes["b->c"]).toBeDefined();
    expect(routes["c->b"]).toBeDefined();
    // ELK separates the forward and back edges (they don't share the same polyline)
    expect(JSON.stringify(routes["b->c"])).not.toEqual(JSON.stringify(routes["c->b"]));
  });

  it("empty graph -> empty layout", async () => {
    expect(await elkLayout([], [], size)).toEqual({ pos: {}, routes: {} });
  });
});
