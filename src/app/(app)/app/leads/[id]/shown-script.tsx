'use client';

// FR-098 (owner decisions 2026-10-29): the published script version last shown in the lead-page
// drawer on this page visit. The script panel sets it whenever the drawer is open on a script
// (on opening, and on choosing another match); closing the drawer keeps it. The outcome sheet
// sends it with the interaction. Nothing is stored when the drawer was never opened, and
// showing a script writes nothing on its own.
import { createContext, useContext, useState, type ReactNode } from 'react';

export interface ShownScript {
  versionId: string;
  name: string;
  versionNo: number;
}

const Ctx = createContext<{
  shown: ShownScript | null;
  setShown: (s: ShownScript) => void;
}>({ shown: null, setShown: () => {} });

export function ShownScriptProvider({
  children,
  initial = null,
}: {
  children: ReactNode;
  /** Only for rendering tests: nothing is shown until the drawer opens. */
  initial?: ShownScript | null;
}) {
  const [shown, setShown] = useState<ShownScript | null>(initial);
  return <Ctx.Provider value={{ shown, setShown }}>{children}</Ctx.Provider>;
}

export const useShownScript = () => useContext(Ctx);
