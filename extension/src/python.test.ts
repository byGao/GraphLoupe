/** AC-01: interpreter resolution priority + preflight doctor parsing/messaging. */
import { describe, it, expect } from "vitest";
import {
  fallbackCandidates,
  resolvePython,
  parseImportProbe,
  pyLabel,
  doctorMessage,
  interpreterNotFoundMessage,
  type PyCommand,
} from "./python";

const yes = () => true;
const no = () => false;

describe("resolvePython priority (R-01/R-02)", () => {
  const fb = fallbackCandidates("win32");

  it("explicit config wins over ms-python and fallback", () => {
    const r = resolvePython({
      configPath: "C:/envs/proj/python.exe",
      msPythonPath: "C:/ms/python.exe",
      fallback: fb,
      exists: yes,
    });
    expect(r).toEqual({ command: "C:/envs/proj/python.exe", args: [] });
  });

  it("ms-python active env is used when config is empty", () => {
    const r = resolvePython({
      configPath: "  ",
      msPythonPath: "/venv/bin/python",
      fallback: fb,
      exists: yes,
    });
    expect(r).toEqual({ command: "/venv/bin/python", args: [] });
  });

  it("falls back to `py -3` on Windows when config + ms-python absent and python missing", () => {
    // only `py` resolves; `python`/`python3` do not
    const exists = (c: PyCommand) => c.command === "py";
    const r = resolvePython({ fallback: fallbackCandidates("win32"), exists });
    expect(r).toEqual({ command: "py", args: ["-3"] });
  });

  it("ms-python absent does not throw — drops to fallback", () => {
    const r = resolvePython({ msPythonPath: undefined, fallback: fallbackCandidates("linux"), exists: yes });
    expect(r).toEqual({ command: "python3", args: [] });
  });

  it("returns undefined when nothing resolves", () => {
    expect(resolvePython({ fallback: fallbackCandidates("linux"), exists: no })).toBeUndefined();
  });
});

describe("fallbackCandidates ordering", () => {
  it("Windows tries the py launcher first", () => {
    expect(fallbackCandidates("win32")[0]).toEqual({ command: "py", args: ["-3"] });
  });
  it("posix tries python3 first, no py launcher", () => {
    const fb = fallbackCandidates("darwin");
    expect(fb[0]).toEqual({ command: "python3", args: [] });
    expect(fb.some((c) => c.command === "py")).toBe(false);
  });
});

describe("preflight doctor (R-03)", () => {
  it("status 0 -> no missing modules", () => {
    expect(parseImportProbe(0, "")).toEqual([]);
  });

  it("extracts the missing module from a ModuleNotFoundError", () => {
    const stderr = "Traceback...\nModuleNotFoundError: No module named 'langgraph'\n";
    expect(parseImportProbe(1, stderr)).toEqual(["langgraph"]);
  });

  it("recommends leaf deps, not the lockfile that would clobber langgraph (#107)", () => {
    const msg = doctorMessage({ command: "py", args: ["-3"] }, ["fastapi"]);
    expect(msg).toContain("py -3");
    expect(msg).toContain("fastapi");
    expect(msg).toContain("pip install fastapi uvicorn starlette");
    expect(msg).not.toContain("requirements.lock");
  });

  it("not-found message points at install / select / pythonPath, not a raw ENOENT", () => {
    const msg = interpreterNotFoundMessage();
    expect(msg).toMatch(/Select Interpreter/);
    expect(msg).toContain("graphloupe.pythonPath");
    expect(msg).not.toMatch(/ENOENT/);
  });
});

describe("pyLabel", () => {
  it("joins args, omits them when empty", () => {
    expect(pyLabel({ command: "py", args: ["-3"] })).toBe("py -3");
    expect(pyLabel({ command: "/venv/bin/python", args: [] })).toBe("/venv/bin/python");
  });
});
