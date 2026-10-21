import * as React from "react";

export type ThemePreference = "light" | "dark" | "system";
const KEY = "emonitor.theme";

interface ThemeCtx {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (t: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeCtx | null>(null);

function readPreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPref] = React.useState<ThemePreference>(readPreference);
  const [sysDark, setSysDark] = React.useState<boolean>(systemDark);

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSysDark(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const resolved: "light" | "dark" = preference === "system" ? (sysDark ? "dark" : "light") : preference;

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const setPreference = React.useCallback((t: ThemePreference) => {
    setPref(t);
    try {
      window.localStorage.setItem(KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  const value = React.useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
