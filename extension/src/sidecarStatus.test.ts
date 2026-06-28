/** AC-01: sidecar lifecycle reducer — kill vs unexpected exit is the key split. */
import { describe, it, expect } from "vitest";
import { initialStatus, nextStatus, statusLabel, spawnErrorMessage } from "./sidecarStatus";

describe("sidecar status machine", () => {
  it("spawn -> starting -> running on open", () => {
    let s = nextStatus(initialStatus, { t: "spawn" });
    expect(s.state).toBe("starting");
    s = nextStatus(s, { t: "open" });
    expect(s.state).toBe("running");
  });

  it("a kill we asked for -> stopped; the same exit, unexpected -> failed", () => {
    expect(nextStatus({ state: "running" }, { t: "kill" }).state).toBe("stopped");
    expect(nextStatus({ state: "running" }, { t: "exit", expected: true }).state).toBe("stopped");
    const crashed = nextStatus({ state: "running" }, { t: "exit", expected: false, reason: "code 1" });
    expect(crashed).toEqual({ state: "failed", reason: "code 1" });
  });

  it("spawn/connect errors -> failed with reason", () => {
    expect(nextStatus(initialStatus, { t: "spawnError", reason: "ENOENT" })).toEqual({ state: "failed", reason: "ENOENT" });
    expect(nextStatus(initialStatus, { t: "connectFail", reason: "timeout" }).state).toBe("failed");
  });

  it("statusLabel flags failed as a warning; running is not", () => {
    expect(statusLabel({ state: "running" }).warn).toBe(false);
    const f = statusLabel({ state: "failed", reason: "boom" });
    expect(f.warn).toBe(true);
    expect(f.tooltip).toContain("boom");
  });

  it("spawnErrorMessage names Python on ENOENT", () => {
    expect(spawnErrorMessage({ code: "ENOENT" })).toMatch(/Python was not found/);
    expect(spawnErrorMessage({ message: "boom" })).toMatch(/boom/);
  });
});
