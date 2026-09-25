import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// The name of the lab open in the Workspace, for chrome that sits outside WorkspacePage (the
// desktop title bar). The route only carries the lab's id — derived by the backend from the lab
// directory's path, meaningless to a person — so the name has to be handed over by the page that
// loaded the lab rather than read off the URL.
interface OpenLabNameCtx {
  name: string | null;
  setName: (name: string | null) => void;
}

const Ctx = createContext<OpenLabNameCtx | null>(null);

export function OpenLabNameProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<string | null>(null);
  return <Ctx.Provider value={{ name, setName }}>{children}</Ctx.Provider>;
}

/** The open lab's name, or null when no lab is open. */
export function useOpenLabName(): string | null {
  return useContext(Ctx)?.name ?? null;
}

/** Publishes `name` as the open lab's name for as long as the caller is mounted. */
export function usePublishOpenLabName(name: string | null): void {
  const setName = useContext(Ctx)?.setName;
  useEffect(() => {
    if (!setName) return;
    setName(name);
    return () => setName(null);
  }, [name, setName]);
}
