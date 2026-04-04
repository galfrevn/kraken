import { useState, useCallback, useRef } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";

export interface SlashCommandDefinition {
  name: string;
  aliases?: string[];
}

export interface CommandRegistration {
  title: string;
  value: string;
  description?: string;
  slash?: SlashCommandDefinition;
  onSelect?: () => void;
}

export interface AutocompleteOption {
  display: string;
  value?: string;
  aliases?: string[];
  description?: string;
  onSelect?: () => void;
}

export const { Provider: CommandsProvider, use: useCommands } = createSimpleContext({
  name: "Commands",
  init: () => {
    const registrationFactoriesReference = useRef<Array<() => CommandRegistration[]>>([]);
    const [registrationVersion, setRegistrationVersion] = useState(0);

    const register = useCallback((commandsFactory: () => CommandRegistration[]) => {
      registrationFactoriesReference.current.push(commandsFactory);
      setRegistrationVersion((previousVersion) => previousVersion + 1);

      return () => {
        const factoryIndex = registrationFactoriesReference.current.indexOf(commandsFactory);
        if (factoryIndex !== -1) {
          registrationFactoriesReference.current.splice(factoryIndex, 1);
          setRegistrationVersion((previousVersion) => previousVersion + 1);
        }
      };
    }, []);

    const slashes = useCallback((): AutocompleteOption[] => {
      void registrationVersion;

      const allRegistrations = registrationFactoriesReference.current.flatMap((factory) =>
        factory(),
      );

      const slashCommands: AutocompleteOption[] = [];

      for (const registration of allRegistrations) {
        if (!registration.slash) continue;
        slashCommands.push({
          display: "/" + registration.slash.name,
          description: registration.description ?? registration.title,
          aliases: registration.slash.aliases?.map((alias) => "/" + alias),
          onSelect: registration.onSelect,
        });
      }

      slashCommands.sort((commandA, commandB) => commandA.display.localeCompare(commandB.display));

      const longestDisplayLength = slashCommands.reduce(
        (maximumLength, command) => Math.max(maximumLength, command.display.length),
        0,
      );

      return slashCommands.map((command) => ({
        ...command,
        display: command.display.padEnd(longestDisplayLength + 2),
      }));
    }, [registrationVersion]);

    const trigger = useCallback((commandValue: string) => {
      const allRegistrations = registrationFactoriesReference.current.flatMap((factory) =>
        factory(),
      );
      const matchingRegistration = allRegistrations.find(
        (registration) => registration.value === commandValue,
      );
      matchingRegistration?.onSelect?.();
    }, []);

    return { register, slashes, trigger };
  },
});
