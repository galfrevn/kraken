import { createContext, useContext, type ReactNode } from "react";

interface SimpleContextOptions<TValue> {
  name: string;
  init: () => TValue;
}

export function createSimpleContext<TValue>(options: SimpleContextOptions<TValue>) {
  const Context = createContext<TValue | null>(null);

  const Provider = ({ children }: { children: ReactNode }) => {
    const value = options.init();
    const isReady = (value as Record<string, unknown>).ready ?? true;

    if (!isReady) return <box />;

    return <Context.Provider value={value}>{children}</Context.Provider>;
  };

  function use(): TValue {
    const contextValue = useContext(Context);
    if (contextValue === null) {
      throw new Error(`${options.name} context not found. Wrap with <${options.name}Provider>.`);
    }
    return contextValue;
  }

  return { Provider, use };
}
