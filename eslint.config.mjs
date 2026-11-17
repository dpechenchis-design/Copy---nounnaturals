import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { SAMPLE_ALLOWED, TEMPORARY_SAMPLE_IMPORTERS } from "./src/lib/content/sample-importers.mjs";

/* Zero demo data in the published app (owner, Nov 15 2026): demo content reaches a screen only through
   src/lib/content (its demo-bundle.ts, loaded on test runs only). Importing a type from src/lib/sample is fine;
   importing a value is an error everywhere but the files in src/lib/content/sample-importers.mjs. */
const SAMPLE_IMPORT = {
  regex: String.raw`^(@/lib/sample|(\.{1,2}/)+(lib/)?sample)(/.*)?$`,
  allowTypeImports: true,
  message: "Demo data comes only through src/lib/content (a loader there). Import types from @/lib/content/types and fixed lists from @/lib/content/lists.",
};

/** a file path as a glob: the brackets and parentheses of route folders ([id], (app)) are taken literally */
const literal = (path) => path.replace(/[[\]()]/g, (c) => `\\${c}`);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [SAMPLE_IMPORT] }],
    },
  },
  {
    files: [...SAMPLE_ALLOWED, ...TEMPORARY_SAMPLE_IMPORTERS.map(literal)],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // The Gemini reader worker has its own package, tsconfig and checks (worker/):
    "worker/**",
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The prototype and one off scripts are not part of the app:
    "design/**",
    "scripts/**",
    // Other Claude sessions' worktrees (copies of the repo) are not this checkout:
    ".claude/**",
  ]),
]);

export default eslintConfig;
