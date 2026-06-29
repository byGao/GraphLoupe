/** AC-01: managed venv path layout + bootstrap decision (P0-3b). */
import { describe, it, expect } from "vitest";
import { venvPython, needsBootstrap, SIDECAR_VENV_DEPS } from "./venv";

describe("venvPython layout (R-01)", () => {
  it("Windows uses Scripts/python.exe", () => {
    expect(venvPython("C:/store/sidecar-venv", "win32").replace(/\\/g, "/")).toBe(
      "C:/store/sidecar-venv/Scripts/python.exe",
    );
  });
  it("posix uses bin/python", () => {
    expect(venvPython("/home/u/.cfg/sidecar-venv", "linux")).toBe("/home/u/.cfg/sidecar-venv/bin/python");
  });
});

describe("needsBootstrap (R-02)", () => {
  it("missing interpreter -> needs bootstrap", () => {
    expect(needsBootstrap({ pythonExists: false, importsDeps: false })).toBe(true);
  });
  it("present but deps missing (half-built) -> needs bootstrap", () => {
    expect(needsBootstrap({ pythonExists: true, importsDeps: false })).toBe(true);
  });
  it("present and deps import -> ready, skip", () => {
    expect(needsBootstrap({ pythonExists: true, importsDeps: true })).toBe(false);
  });
});

describe("SIDECAR_VENV_DEPS", () => {
  it("ships the web stack but never langgraph (worker's interpreter owns that)", () => {
    expect(SIDECAR_VENV_DEPS).toContain("fastapi==0.115.0");
    expect(SIDECAR_VENV_DEPS.some((d) => d.startsWith("langgraph"))).toBe(false);
  });
});
