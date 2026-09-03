// Flat ESLint config for the frontend. Deliberately narrow: TypeScript already covers types and
// unused locals (see tsconfig.app.json's `noUnusedLocals`/`noUnusedParameters`), so what's worth
// adding on top is the rules a type-checker structurally cannot see — above all the React Hooks
// rules. The codebase's `// eslint-disable-next-line react-hooks/exhaustive-deps` comments predate
// this config and each documents a deliberate choice; they only actually do anything now.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Vite's fast refresh only handles files that export components; a component file that also
      // exports a constant silently loses HMR. A warning, not an error — several files here
      // legitimately co-locate a type/context with their component. allowExportNames lists the
      // hooks that intentionally live next to their own context's Provider (so callers only need
      // one import path per context) and the form-state helpers colocated with the component that
      // owns their shape.
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "useWorkspaceCore",
            "useWorkspace",
            "useToast",
            "useNotifications",
            "usePrompt",
            "useConfirm",
            "useDesktopCommand",
            "useDesktopDispatch",
            "useElevate",
            "useOnboardingTour",
            "useOnboardingTourReady",
            "useOnboardingTourFocusPanel",
            "useOnboardingTourSelectFirstDevice",
            "useOnboardingTourInternal",
            "defaultOptionsFormState",
            "optionsFormStateFromMachine",
            "optionsFormStateToPayload",
          ],
        },
      ],
      // `_`-prefixed bindings are the codebase's convention for a deliberately-ignored value
      // (a destructured field dropped from a payload, an unused handler argument).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
