// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { prefersReducedMotion, useReducedMotion } from "./use-reduced-motion";

/**
 * A controllable `matchMedia` stub that mimics the real MediaQueryList:
 * `matches` reflects the current preference and `change` listeners fire when
 * the preference is toggled at the OS level.
 */
type Stub = {
  set(matches: boolean): void;
  listenerCount(): number;
  queries: string[];
  addCalls: number;
  removeCalls: number;
  legacy: boolean;
};

function installMatchMedia(initial: boolean, opts: { legacy?: boolean } = {}): Stub {
  const state = { matches: initial };
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const stub: Stub = {
    queries: [],
    addCalls: 0,
    removeCalls: 0,
    legacy: opts.legacy ?? false,
    listenerCount: () => listeners.size,
    set(matches: boolean) {
      state.matches = matches;
      const event = { matches, media: "(prefers-reduced-motion: reduce)" } as MediaQueryListEvent;
      for (const l of Array.from(listeners)) l(event);
    },
  };

  window.matchMedia = ((query: string) => {
    stub.queries.push(query);
    const mql = {
      get matches() {
        return state.matches;
      },
      media: query,
      onchange: null,
      addEventListener: (type: string, cb: (e: MediaQueryListEvent) => void) => {
        if (type !== "change") return;
        stub.addCalls += 1;
        listeners.add(cb);
      },
      removeEventListener: (type: string, cb: (e: MediaQueryListEvent) => void) => {
        if (type !== "change") return;
        stub.removeCalls += 1;
        listeners.delete(cb);
      },
      addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    };
    if (stub.legacy) {
      // Simulate an old browser with no modern listener API.
      delete (mql as Record<string, unknown>)["addEventListener"];
      delete (mql as Record<string, unknown>)["removeEventListener"];
    }
    return mql as unknown as MediaQueryList;
  }) as typeof window.matchMedia;

  return stub;
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe("useReducedMotion", () => {
  it("queries the prefers-reduced-motion media feature", () => {
    const stub = installMatchMedia(false);
    renderHook(() => useReducedMotion());
    expect(stub.queries).toContain("(prefers-reduced-motion: reduce)");
  });

  it("syncs to the current preference on mount", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("starts false when the preference is not set", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it("reacts when the media query toggles on and back off", () => {
    const stub = installMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => stub.set(true));
    expect(result.current).toBe(true);

    act(() => stub.set(false));
    expect(result.current).toBe(false);
  });

  it("handles rapid repeated toggles and settles on the last value", () => {
    const stub = installMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());

    act(() => {
      stub.set(true);
      stub.set(false);
      stub.set(true);
    });
    expect(result.current).toBe(true);

    act(() => {
      stub.set(false);
      stub.set(true);
      stub.set(false);
    });
    expect(result.current).toBe(false);
  });

  it("does not re-render for a repeated identical value", () => {
    const stub = installMatchMedia(false);
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useReducedMotion();
    });
    const afterMount = renders;

    act(() => stub.set(false));
    act(() => stub.set(false));
    expect(renders).toBe(afterMount);

    act(() => stub.set(true));
    expect(renders).toBeGreaterThan(afterMount);
  });

  it("subscribes once and unsubscribes on unmount", () => {
    const stub = installMatchMedia(false);
    const { unmount } = renderHook(() => useReducedMotion());
    expect(stub.addCalls).toBe(1);
    expect(stub.listenerCount()).toBe(1);

    unmount();
    expect(stub.removeCalls).toBe(1);
    expect(stub.listenerCount()).toBe(0);
  });

  it("ignores preference changes after unmount (no update on an unmounted hook)", () => {
    const stub = installMatchMedia(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useReducedMotion());
    unmount();

    act(() => stub.set(true));
    expect(result.current).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("keeps multiple consumers in sync with one toggle", () => {
    const stub = installMatchMedia(false);
    const a = renderHook(() => useReducedMotion());
    const b = renderHook(() => useReducedMotion());

    act(() => stub.set(true));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
  });

  it("drives rendered output when the preference toggles", () => {
    const stub = installMatchMedia(false);
    function Widget() {
      const reduced = useReducedMotion();
      return <span data-testid="mode">{reduced ? "static" : "animated"}</span>;
    }
    render(<Widget />);
    expect(screen.getByTestId("mode").textContent).toBe("animated");

    act(() => stub.set(true));
    expect(screen.getByTestId("mode").textContent).toBe("static");

    act(() => stub.set(false));
    expect(screen.getByTestId("mode").textContent).toBe("animated");
  });

  it("returns false and does not throw when matchMedia is unavailable", () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    expect(() => unmount()).not.toThrow();
  });

  it("does not crash on browsers lacking addEventListener on MediaQueryList", () => {
    installMatchMedia(true, { legacy: true });
    expect(() => renderHook(() => useReducedMotion())).not.toThrow();
  });
});

describe("prefersReducedMotion", () => {
  it("reads the live value without subscribing", () => {
    const stub = installMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
    stub.set(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(stub.addCalls).toBe(0);
  });

  it("returns false when matchMedia is unavailable", () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });
});
